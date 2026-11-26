import Charts
import SwiftData
import SwiftUI

private struct ProgressPoint: Identifiable {
    let date: Date
    let kg: Double
    var id: Date { date }
}

/// One exercise: where it came from, your records and every time you did it.
struct ExerciseDetailView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @AppStorage(SettingsKey.effort) private var effort: EffortScale = .rpe
    @Bindable var exercise: Exercise
    @State private var showEditor = false
    @State private var confirmDelete = false

    /// Finished sessions containing this exercise, newest first.
    private var sessions: [WorkoutExercise] {
        exercise.entries
            .filter { $0.workout?.endedAt != nil && $0.sets.contains(where: \.isDone) }
            .sorted { ($0.workout?.startedAt ?? .distantPast) > ($1.workout?.startedAt ?? .distantPast) }
    }

    var body: some View {
        let sessions = self.sessions
        let workingSets = sessions.flatMap(\.sets).filter { $0.isDone && !$0.isWarmup }

        List {
            Section {
                LabeledContent("Muscle group", value: exercise.muscle.title)
                LabeledContent("Equipment", value: exercise.equipment.title)
                if let link = exercise.videoURL, let url = URL(string: link) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Watch Video", systemImage: "play.rectangle.fill")
                    }
                }
                Toggle("Want to try", isOn: $exercise.wantToTry)
            } footer: {
                Text("Exercises marked “Want to try” are listed first when you add exercises to a workout.")
            }

            if !exercise.notes.isEmpty {
                Section("Notes") {
                    Text(exercise.notes)
                }
            }

            if !workingSets.isEmpty {
                Section("Records") {
                    if let heaviest = workingSets.compactMap(\.weight).max() {
                        LabeledContent("Heaviest weight", value: unit.text(kg: heaviest))
                    }
                    if let best = workingSets.compactMap(\.estimatedOneRepMax).max() {
                        LabeledContent("Estimated 1RM", value: unit.text(kg: best))
                    }
                    if let reps = workingSets.compactMap(\.reps).max() {
                        LabeledContent("Most reps", value: "\(reps)")
                    }
                    LabeledContent("Sessions", value: "\(sessions.count)")
                }

                let points = progress(from: sessions)
                if points.count > 1 {
                    Section("Top set") {
                        Chart(points) { point in
                            LineMark(x: .value("Date", point.date), y: .value("Weight", unit.fromKg(point.kg)))
                                .interpolationMethod(.monotone)
                            PointMark(x: .value("Date", point.date), y: .value("Weight", unit.fromKg(point.kg)))
                                .symbolSize(28)
                        }
                        .chartYScale(domain: .automatic(includesZero: false))
                        .frame(height: 160)
                        .padding(.vertical, 6)
                    }
                }
            }

            if sessions.isEmpty {
                Section("History") {
                    Text("You haven't done this exercise yet.")
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(sessions) { session in
                    Section {
                        ForEach(session.sortedSets.filter(\.isDone)) { set in
                            HStack {
                                Text(setText(set))
                                if set.isWarmup {
                                    Text("warm-up")
                                        .font(.caption)
                                        .foregroundStyle(.orange)
                                }
                                Spacer()
                                if let rpe = set.rpe {
                                    Text(effort.label(rpe: rpe))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .monospacedDigit()
                        }
                    } header: {
                        if let workout = session.workout {
                            Text("\(workout.startedAt.formatted(date: .abbreviated, time: .omitted)) · \(workout.name)")
                        }
                    }
                }
            }
        }
        .navigationTitle(exercise.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Edit", systemImage: "pencil") { showEditor = true }
                    Button("Delete Exercise", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(isPresented: $showEditor) {
            ExerciseEditorView(exercise: exercise)
        }
        .confirmationDialog("Delete “\(exercise.name)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Exercise", role: .destructive) {
                dismiss()
                afterDismissal {
                    context.delete(exercise)
                    try? context.save()
                }
            }
        } message: {
            Text(sessions.isEmpty
                 ? "It will be removed from your exercise list."
                 : "Past workouts keep their sets, but this exercise's records and history page go away.")
        }
    }

    private func setText(_ set: SetEntry) -> String {
        let reps = set.reps.map(String.init) ?? "–"
        guard let weight = set.weight else { return "\(reps) reps" }
        return "\(unit.text(kg: weight)) × \(reps)"
    }

    /// Heaviest working set per session, oldest first, for the chart.
    private func progress(from sessions: [WorkoutExercise]) -> [ProgressPoint] {
        sessions.reversed().compactMap { session in
            guard let date = session.workout?.startedAt,
                  let top = session.sets.filter({ $0.isDone && !$0.isWarmup }).compactMap(\.weight).max() else {
                return nil
            }
            return ProgressPoint(date: date, kg: top)
        }
    }
}
