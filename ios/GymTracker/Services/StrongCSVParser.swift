import Foundation

/// Workout history as read from a Strong export, before it touches the database.
struct StrongImport {
    struct ParsedSet: Equatable {
        var weight: Double?
        var reps: Int?
        var rpe: Double?
        var isWarmup = false
    }

    struct ParsedExercise {
        var name: String
        var notes = ""
        var sets: [ParsedSet] = []
    }

    struct ParsedWorkout {
        var date: Date
        var name: String
        var duration: TimeInterval?
        var notes = ""
        var exercises: [ParsedExercise] = []
    }

    var workouts: [ParsedWorkout] = []
    /// Set when the header names the unit ("Weight (kg)"); older exports don't.
    var headerUnit: WeightUnit?
    var skippedRows = 0

    var setCount: Int { workouts.reduce(0) { $0 + $1.exercises.reduce(0) { $0 + $1.sets.count } } }
    var exerciseNames: Set<String> { Set(workouts.flatMap { $0.exercises.map(\.name) }) }
}

/// Reads both Strong CSV layouts: the older comma-separated one
/// (`Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,…,RPE`) and the
/// newer semicolon-separated one (`Workout #;Date;…;Duration (sec);…;Weight (kg);…`).
enum StrongCSVParser {
    enum Failure: LocalizedError, Equatable {
        case empty
        case missingColumns([String])

        var errorDescription: String? {
            switch self {
            case .empty:
                "The file is empty."
            case .missingColumns(let names):
                "This doesn't look like a Strong export — missing column(s): \(names.joined(separator: ", "))."
            }
        }
    }

    static func parse(_ input: String) throws -> StrongImport {
        var text = input
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        guard let firstLine = text.split(whereSeparator: \.isNewline).first else { throw Failure.empty }
        let semicolons = firstLine.filter { $0 == ";" }.count
        let commas = firstLine.filter { $0 == "," }.count
        var rows = records(in: text, delimiter: semicolons > commas ? ";" : ",")
        guard !rows.isEmpty else { throw Failure.empty }

        let header = rows.removeFirst().map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        func column(_ matches: (String) -> Bool) -> Int? { header.firstIndex(where: matches) }

        let dateCol = column { $0 == "date" }
        let exerciseCol = column { $0 == "exercise name" }
        let setCol = column { $0 == "set order" }
        let repsCol = column { $0 == "reps" }
        let weightCol = column { $0.hasPrefix("weight") }
        let required: [(String, Int?)] = [
            ("Date", dateCol), ("Exercise Name", exerciseCol), ("Set Order", setCol),
            ("Weight", weightCol), ("Reps", repsCol),
        ]
        let missing = required.filter { $0.1 == nil }.map(\.0)
        guard let dateCol, let exerciseCol, let setCol, let repsCol, let weightCol else {
            throw Failure.missingColumns(missing)
        }
        let numberCol = column { $0 == "workout #" }
        let nameCol = column { $0 == "workout name" }
        let durationCol = column { $0.hasPrefix("duration") || $0.hasPrefix("workout duration") }
        let rpeCol = column { $0 == "rpe" }
        let secondsCol = column { $0 == "seconds" }
        let notesCol = column { $0 == "notes" }
        let workoutNotesCol = column { $0 == "workout notes" }

        var result = StrongImport()
        let weightHeader = header[weightCol]
        if weightHeader.contains("kg") { result.headerUnit = .kg }
        if weightHeader.contains("lb") { result.headerUnit = .lb }

        let dates = DateFormatter()
        dates.locale = Locale(identifier: "en_US_POSIX")
        dates.dateFormat = "yyyy-MM-dd HH:mm:ss"

        var indexByKey: [String: Int] = [:]
        for row in rows {
            func cell(_ index: Int?) -> String {
                guard let index, index < row.count else { return "" }
                return row[index].trimmingCharacters(in: .whitespaces)
            }
            let exerciseName = cell(exerciseCol)
            guard let date = dates.date(from: cell(dateCol)), !exerciseName.isEmpty else {
                result.skippedRows += 1
                continue
            }

            let workoutName = cell(nameCol)
            let key = numberCol != nil ? cell(numberCol) : "\(cell(dateCol))|\(workoutName)"
            let workoutIndex: Int
            if let known = indexByKey[key] {
                workoutIndex = known
            } else {
                workoutIndex = result.workouts.count
                indexByKey[key] = workoutIndex
                result.workouts.append(.init(
                    date: date,
                    name: workoutName.isEmpty ? "Workout" : workoutName,
                    duration: duration(cell(durationCol)),
                    notes: cell(workoutNotesCol)
                ))
            }

            // Consecutive rows of the same exercise form one block; the same
            // exercise appearing again later in the workout starts a new one.
            if result.workouts[workoutIndex].exercises.last?.name != exerciseName {
                result.workouts[workoutIndex].exercises.append(.init(name: exerciseName))
            }
            let exerciseIndex = result.workouts[workoutIndex].exercises.count - 1

            let setOrder = cell(setCol).lowercased()
            if setOrder == "note" {
                result.workouts[workoutIndex].exercises[exerciseIndex].notes = cell(notesCol)
                continue
            }
            if setOrder.contains("rest") { continue }

            let weight = Fmt.parseDecimal(cell(weightCol)).flatMap { $0 > 0 ? $0 : nil }
            var reps = Fmt.parseDecimal(cell(repsCol)).flatMap(plausible)
                .map { Int($0.rounded()) }.flatMap { $0 > 0 ? $0 : nil }
            // Timed exercises (planks…) carry seconds instead of reps.
            if reps == nil, let seconds = Fmt.parseDecimal(cell(secondsCol)).flatMap(plausible) {
                reps = Int(seconds.rounded())
            }
            guard weight != nil || reps != nil else {
                result.skippedRows += 1
                continue
            }
            let rpe = Fmt.parseDecimal(cell(rpeCol)).flatMap { (1...10).contains($0) ? $0 : nil }
            result.workouts[workoutIndex].exercises[exerciseIndex].sets.append(
                .init(weight: weight, reps: reps, rpe: rpe, isWarmup: setOrder == "w")
            )
        }

        for index in result.workouts.indices {
            result.workouts[index].exercises.removeAll(where: \.sets.isEmpty)
        }
        result.workouts.removeAll(where: \.exercises.isEmpty)
        result.workouts.sort { $0.date < $1.date }
        return result
    }

    /// Reps and seconds beyond this are a garbled cell, not a set or a workout.
    private static let largestPlausible = 100_000.0

    /// `value` when it is a positive count that can be believed, otherwise nil.
    /// A cell like "1e19" or "inf" parses as a number, but turning it into an
    /// `Int` — here or later, when a duration is formatted — traps.
    private static func plausible(_ value: Double) -> Double? {
        value > 0 && value <= largestPlausible ? value : nil
    }

    /// "1h 5m", "45m", "30s" or plain seconds.
    static func duration(_ raw: String) -> TimeInterval? {
        let text = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard !text.isEmpty else { return nil }
        if let seconds = Double(text) { return plausible(seconds) }
        var total = 0.0
        var digits = ""
        for character in text {
            if character.isNumber {
                digits.append(character)
                continue
            }
            guard let value = Double(digits) else { continue }
            switch character {
            case "h": total += value * 3600
            case "m": total += value * 60
            case "s": total += value
            default: continue
            }
            digits = ""
        }
        return plausible(total)
    }

    /// RFC 4180 record splitter: quoted fields may contain the delimiter,
    /// line breaks and doubled quotes.
    static func records(in text: String, delimiter: Character) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        let characters = Array(text)
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if inQuotes {
                if character == "\"" {
                    if index + 1 < characters.count, characters[index + 1] == "\"" {
                        field.append("\"")
                        index += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(character)
                }
            } else if character == "\"" {
                inQuotes = true
            } else if character == delimiter {
                row.append(field)
                field = ""
            } else if character.isNewline {
                row.append(field)
                field = ""
                if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
                row = []
            } else {
                field.append(character)
            }
            index += 1
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        return rows
    }
}
