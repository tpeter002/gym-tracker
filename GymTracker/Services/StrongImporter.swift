import Foundation
import SwiftData

/// Writes a parsed Strong export into the database.
@MainActor
enum StrongImporter {
    struct Summary {
        var workouts = 0
        var sets = 0
        var newExercises = 0
        var alreadyImported = 0
    }

    static func apply(_ data: StrongImport, unit: WeightUnit, context: ModelContext) -> Summary {
        var summary = Summary()

        let existingExercises = (try? context.fetch(FetchDescriptor<Exercise>())) ?? []
        var exercisesByKey = Dictionary(
            existingExercises.map { (Exercise.normalize($0.name), $0) },
            uniquingKeysWith: { first, _ in first }
        )
        // Re-importing the same file must not duplicate history.
        let existingWorkouts = (try? context.fetch(FetchDescriptor<Workout>())) ?? []
        var knownStarts = Set(existingWorkouts.map { Int($0.startedAt.timeIntervalSinceReferenceDate) })

        for parsed in data.workouts {
            guard knownStarts.insert(Int(parsed.date.timeIntervalSinceReferenceDate)).inserted else {
                summary.alreadyImported += 1
                continue
            }
            let workout = Workout(
                name: parsed.name,
                startedAt: parsed.date,
                endedAt: parsed.date.addingTimeInterval(parsed.duration ?? 0),
                notes: parsed.notes
            )
            context.insert(workout)

            for (order, parsedExercise) in parsed.exercises.enumerated() {
                let key = Exercise.normalize(parsedExercise.name)
                let exercise: Exercise
                if let known = exercisesByKey[key] {
                    exercise = known
                } else {
                    exercise = Exercise(
                        name: parsedExercise.name,
                        muscle: guessMuscle(parsedExercise.name),
                        equipment: guessEquipment(parsedExercise.name),
                        isCustom: true
                    )
                    context.insert(exercise)
                    exercisesByKey[key] = exercise
                    summary.newExercises += 1
                }

                let entry = WorkoutService.insertEntry(for: exercise, into: workout, order: order,
                                                       notes: parsedExercise.notes, context: context)
                for (index, parsedSet) in parsedExercise.sets.enumerated() {
                    let set = SetEntry(
                        order: index,
                        weight: parsedSet.weight.map(unit.toKg),
                        reps: parsedSet.reps,
                        rpe: parsedSet.rpe,
                        isWarmup: parsedSet.isWarmup,
                        isDone: true
                    )
                    WorkoutService.insert(set, into: entry, context: context)
                    summary.sets += 1
                }
            }
            summary.workouts += 1
        }
        try? context.save()
        return summary
    }

    /// Best-effort grouping for exercises that aren't in the built-in library.
    /// Order matters: "Leg Curl" must hit hamstrings before "curl" hits biceps.
    nonisolated static func guessMuscle(_ name: String) -> MuscleGroup {
        let text = name.lowercased()
        let rules: [(MuscleGroup, [String])] = [
            (.shoulders, ["overhead press", "shoulder", "lateral raise", "front raise", "reverse fly",
                          "rear delt", "face pull", "arnold", "upright row", "military"]),
            (.hamstrings, ["leg curl", "hamstring", "romanian", "stiff leg", "good morning", "nordic"]),
            (.glutes, ["hip thrust", "glute", "abduct", "adduct", "pull through"]),
            (.quads, ["squat", "leg press", "leg extension", "lunge", "step up"]),
            (.calves, ["calf", "tibialis"]),
            (.forearms, ["wrist", "forearm", "farmer", "dead hang"]),
            (.cardio, ["running", "treadmill", "cycling", "bike", "elliptical", "rowing", "stair", "jump rope", "walking"]),
            (.triceps, ["tricep", "skull", "pushdown", "close grip bench", "dip"]),
            (.chest, ["bench", "chest", "pec", "fly", "push up", "pushup", "crossover"]),
            (.back, ["row", "pull up", "pullup", "chin up", "pulldown", "deadlift", "back extension", "shrug", "rack pull"]),
            (.biceps, ["curl"]),
            (.core, ["crunch", "plank", "sit up", "leg raise", "knee raise", "twist", "rollout", "woodchop", "pallof", "ab "]),
        ]
        return rules.first { rule in rule.1.contains { text.contains($0) } }?.0 ?? .other
    }

    /// Strong puts the equipment in parentheses: "Bench Press (Barbell)".
    nonisolated static func guessEquipment(_ name: String) -> Equipment {
        guard let open = name.lastIndex(of: "("), let close = name.lastIndex(of: ")"), open < close else {
            return .other
        }
        let hint = name[name.index(after: open)..<close].lowercased()
        if hint.contains("smith") || hint.contains("machine") || hint.contains("assisted") { return .machine }
        if hint.contains("barbell") || hint.contains("ez bar") { return .barbell }
        if hint.contains("dumbbell") { return .dumbbell }
        if hint.contains("cable") { return .cable }
        if hint.contains("kettlebell") { return .kettlebell }
        if hint.contains("band") { return .band }
        if hint.contains("bodyweight") { return .bodyweight }
        return .other
    }
}
