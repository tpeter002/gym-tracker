import SwiftData
import SwiftUI

private struct Month: Identifiable {
    let start: Date
    let workouts: [Workout]
    var id: Date { start }
}

/// Every finished workout, newest first, grouped by month.
struct HistoryView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppRouter.self) private var router
    @Query(filter: #Predicate<Workout> { $0.endedAt != nil }, sort: \Workout.startedAt, order: .reverse)
    private var workouts: [Workout]

    private var months: [Month] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: workouts) { workout in
            calendar.date(from: calendar.dateComponents([.year, .month], from: workout.startedAt)) ?? workout.startedAt
        }
        return grouped.keys.sorted(by: >).map { Month(start: $0, workouts: grouped[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if workouts.isEmpty {
                    ContentUnavailableView(
                        "No Workouts Yet",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Finished workouts appear here. You can also import your Strong history in Settings.")
                    )
                } else {
                    List {
                        ForEach(months) { month in
                            Section {
                                ForEach(month.workouts) { workout in
                                    NavigationLink {
                                        WorkoutDetailView(workout: workout)
                                    } label: {
                                        WorkoutSummaryLabel(workout: workout)
                                    }
                                    .swipeActions(edge: .leading) {
                                        Button {
                                            router.start(.repeating(workout), in: context)
                                        } label: {
                                            Label("Repeat", systemImage: "arrow.clockwise")
                                        }
                                        .tint(.accentColor)
                                    }
                                    .swipeActions(edge: .trailing) {
                                        Button(role: .destructive) {
                                            WorkoutService.delete(workout, in: context)
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                            } header: {
                                HStack {
                                    Text(month.start.formatted(.dateTime.month(.wide).year()))
                                    Spacer()
                                    Text(Fmt.count(month.workouts.count, "workout"))
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
        }
    }
}

/// A finished workout in full, with the button to do it again.
struct WorkoutDetailView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @AppStorage(SettingsKey.effort) private var effort: EffortScale = .rpe
    let workout: Workout
    @State private var confirmDelete = false

    var body: some View {
        List {
            Section {
                LabeledContent("Date", value: workout.startedAt.formatted(date: .abbreviated, time: .shortened))
                if workout.duration >= 60 {
                    LabeledContent("Duration", value: Fmt.duration(workout.duration))
                }
                LabeledContent("Sets", value: "\(workout.doneSets.count)")
                if workout.volumeKg > 0 {
                    LabeledContent("Volume", value: "\(Fmt.number(unit.fromKg(workout.volumeKg), maxDecimals: 0)) \(unit.rawValue)")
                }
                if !workout.notes.isEmpty {
                    Text(workout.notes)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(workout.sortedEntries) { entry in
                let sets = entry.sortedSets
                let labels = sets.rowLabels
                Section {
                    ForEach(Array(sets.enumerated()), id: \.element.persistentModelID) { index, set in
                        HStack {
                            Text(labels[index])
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(set.isWarmup ? Color.orange : Color.secondary)
                                .frame(width: 28, alignment: .leading)
                            Text(set.text(in: unit))
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
                    if let exercise = entry.exercise {
                        NavigationLink {
                            ExerciseDetailView(exercise: exercise)
                        } label: {
                            Text(entry.displayName)
                        }
                    } else {
                        Text(entry.displayName)
                    }
                } footer: {
                    if !entry.notes.isEmpty { Text(entry.notes) }
                }
            }
        }
        .navigationTitle(workout.name)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                router.start(.repeating(workout), in: context)
            } label: {
                Label("Repeat Workout", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Delete Workout", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Workout options")
            }
        }
        .confirmationDialog("Delete this workout?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Workout", role: .destructive) {
                dismiss()
                afterDismissal { WorkoutService.delete(workout, in: context) }
            }
        }
    }
}
