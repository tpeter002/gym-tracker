import SwiftData
import SwiftUI

/// Text-backed number entry. A value-formatted `TextField` only commits when
/// focus leaves, which loses input if you tap the set's checkmark straight
/// after typing; this writes through on every keystroke instead.
struct DecimalField: View {
    @Binding var value: Double?
    var placeholder = ""
    @State private var text = ""

    var body: some View {
        TextField(placeholder, text: $text)
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.center)
            .onAppear { text = value.map { Fmt.number($0) } ?? "" }
            .onChange(of: text) { _, newText in
                let parsed = Fmt.parseDecimal(newText)
                if !same(parsed, value) { value = parsed }
            }
            .onChange(of: value) { _, newValue in
                // Only rewrite the text for changes that came from outside
                // (e.g. "use last time's numbers"), never mid-typing.
                if !same(Fmt.parseDecimal(text), newValue) {
                    text = newValue.map { Fmt.number($0) } ?? ""
                }
            }
    }

    /// Tolerant comparison: unit conversion makes 135 lb round-trip as 134.9999….
    private func same(_ a: Double?, _ b: Double?) -> Bool {
        switch (a, b) {
        case (nil, nil): true
        case let (a?, b?): abs(a - b) < 0.005
        default: false
        }
    }
}

struct IntegerField: View {
    @Binding var value: Int?
    var placeholder = ""
    @State private var text = ""

    var body: some View {
        TextField(placeholder, text: $text)
            .keyboardType(.numberPad)
            .multilineTextAlignment(.center)
            .onAppear { text = value.map(String.init) ?? "" }
            .onChange(of: text) { _, newText in
                let parsed = Int(newText.filter(\.isNumber))
                if parsed != value { value = parsed }
            }
            .onChange(of: value) { _, newValue in
                if Int(text.filter(\.isNumber)) != newValue {
                    text = newValue.map(String.init) ?? ""
                }
            }
    }
}

/// Horizontal chips for narrowing the exercise list to one muscle group.
struct MuscleFilterBar: View {
    @Binding var selection: MuscleGroup?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", isOn: selection == nil) { selection = nil }
                ForEach(MuscleGroup.allCases) { muscle in
                    chip(muscle.title, isOn: selection == muscle) {
                        selection = selection == muscle ? nil : muscle
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func chip(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(isOn ? Color.accentColor : Color(.secondarySystemFill), in: Capsule())
                .foregroundStyle(isOn ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

/// Name, muscle and equipment, plus markers for exercises saved from a video.
struct ExerciseRowLabel: View {
    let exercise: Exercise

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(exercise.name)
                    .font(.body)
                if exercise.wantToTry {
                    Text("To try")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.18), in: Capsule())
                        .foregroundStyle(Color.accentColor)
                }
            }
            HStack(spacing: 4) {
                Text(exercise.subtitle)
                if exercise.videoURL != nil {
                    Image(systemName: "play.rectangle.fill")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

/// History-style summary of a finished workout.
struct WorkoutSummaryLabel: View {
    let workout: Workout

    var body: some View {
        let entries = workout.sortedEntries
        VStack(alignment: .leading, spacing: 6) {
            Text(workout.name)
                .font(.headline)
            HStack(spacing: 10) {
                Label(workout.startedAt.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)),
                      systemImage: "calendar")
                if workout.duration >= 60 {
                    Label(Fmt.duration(workout.duration), systemImage: "clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)

            VStack(alignment: .leading, spacing: 2) {
                ForEach(entries.prefix(4)) { entry in
                    Text("\(entry.sets.count) × \(entry.displayName)")
                        .lineLimit(1)
                }
                if entries.count > 4 {
                    Text("+ \(entries.count - 4) more")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// Live "12:34" clock counting up from the workout's start.
struct ElapsedTimeView: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            Text(Fmt.clock(timeline.date.timeIntervalSince(since)))
                .monospacedDigit()
        }
    }
}

/// Search used by both the Exercises tab and the in-workout picker.
enum ExerciseSearch {
    private static let aliases = ["db": "dumbbell", "bb": "barbell", "kb": "kettlebell", "bw": "bodyweight"]

    static func filter(_ exercises: [Exercise], query: String, muscle: MuscleGroup?) -> [Exercise] {
        let tokens = Exercise.normalize(query).split(separator: " ").map { aliases[String($0)] ?? String($0) }
        let phrase = tokens.joined(separator: " ")
        let scoped = muscle.map { wanted in exercises.filter { $0.muscle == wanted } } ?? exercises
        guard !tokens.isEmpty else { return scoped }

        let ranked: [(exercise: Exercise, rank: Int)] = scoped.compactMap { exercise in
            let name = Exercise.normalize(exercise.name)
            let haystack = "\(name) \(exercise.muscle.title.lowercased()) \(exercise.equipment.title.lowercased())"
            guard tokens.allSatisfy({ haystack.contains($0) }) else { return nil }
            let rank = name.hasPrefix(phrase) ? 0 : (name.contains(phrase) ? 1 : 2)
            return (exercise, rank)
        }
        return ranked
            .sorted { ($0.rank, $0.exercise.name) < ($1.rank, $1.exercise.name) }
            .map(\.exercise)
    }
}

/// Runs `action` once the current screen has finished animating away.
/// SwiftData crashes when a view re-renders a model that was just deleted, so
/// screens that delete (or finish) what they show dismiss first and change the
/// data afterwards.
@MainActor
func afterDismissal(_ action: @escaping @MainActor () -> Void) {
    Task { @MainActor in
        try? await Task.sleep(nanoseconds: ModelContext.screenSettleNanoseconds)
        action()
    }
}

extension View {
    func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
