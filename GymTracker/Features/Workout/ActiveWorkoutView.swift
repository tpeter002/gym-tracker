import SwiftData
import SwiftUI

/// The in-progress workout: exercises, their sets, and the finish / discard flow.
/// Swiping the sheet down only minimises it; the workout keeps running.
struct ActiveWorkoutView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppRouter.self) private var router
    @Bindable var workout: Workout

    @State private var showPicker = false
    @State private var confirmFinish = false
    @State private var confirmDiscard = false
    @State private var showNothingLogged = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Workout name", text: $workout.name)
                        .font(.title3.weight(.semibold))
                    TextField("Notes", text: $workout.notes, axis: .vertical)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                ForEach(workout.sortedEntries) { entry in
                    ExerciseEntrySection(entry: entry, workout: workout)
                }

                Section {
                    Button {
                        showPicker = true
                    } label: {
                        Label("Add Exercise", systemImage: "plus")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                }

                Section {
                    Button("Discard Workout", role: .destructive) {
                        confirmDiscard = true
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        router.showActiveWorkout = false
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .accessibilityLabel("Minimise")
                }
                ToolbarItem(placement: .principal) {
                    ElapsedTimeView(since: workout.startedAt)
                        .font(.headline)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Finish") { requestFinish() }
                        .fontWeight(.semibold)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { hideKeyboard() }
                }
            }
            .sheet(isPresented: $showPicker) {
                ExercisePickerView { exercises in
                    for exercise in exercises {
                        WorkoutService.add(exercise, to: workout, in: context)
                    }
                }
            }
            .confirmationDialog("Finish workout?", isPresented: $confirmFinish, titleVisibility: .visible) {
                Button("Finish") { finish() }
                Button("Keep Going", role: .cancel) {}
            } message: {
                Text("Sets you haven't ticked off won't be saved.")
            }
            .confirmationDialog("Discard this workout?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard Workout", role: .destructive) {
                    router.showActiveWorkout = false
                    afterDismissal { WorkoutService.delete(workout, in: context) }
                }
                Button("Keep Going", role: .cancel) {}
            } message: {
                Text("Everything logged in it will be lost.")
            }
            .alert("Nothing logged yet", isPresented: $showNothingLogged) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Tick off at least one set to finish, or discard the workout.")
            }
        }
    }

    private func requestFinish() {
        hideKeyboard()
        guard WorkoutService.hasCompletedSets(workout) else {
            showNothingLogged = true
            return
        }
        let hasOpenSets = workout.entries.contains { $0.sets.contains { !$0.isDone } }
        if hasOpenSets {
            confirmFinish = true
        } else {
            finish()
        }
    }

    private func finish() {
        let endedAt = Date()
        router.showActiveWorkout = false
        router.tab = .history
        afterDismissal { WorkoutService.finish(workout, endedAt: endedAt, in: context) }
    }
}

/// One exercise block inside the active workout.
private struct ExerciseEntrySection: View {
    @Environment(\.modelContext) private var context
    @Environment(\.openURL) private var openURL
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @AppStorage(SettingsKey.effort) private var effort: EffortScale = .rpe
    let entry: WorkoutExercise
    let workout: Workout

    var body: some View {
        let sets = entry.sortedSets
        let previous = entry.exercise.map { WorkoutService.previousSets(for: $0, excluding: workout) } ?? []
        let labels = sets.rowLabels

        Section {
            header
            columnTitles
            ForEach(Array(sets.enumerated()), id: \.element.persistentModelID) { index, set in
                SetRow(set: set, label: labels[index], previous: index < previous.count ? previous[index] : nil)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            WorkoutService.delete(set, in: context)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
            }
            Button {
                WorkoutService.addSet(to: entry, in: context)
            } label: {
                Label("Add Set", systemImage: "plus")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
        }
        .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.displayName)
                    .font(.headline)
                    .foregroundStyle(Color.accentColor)
                if let notes = entry.exercise?.notes, !notes.isEmpty {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            if let link = entry.exercise?.videoURL, let url = URL(string: link) {
                Button {
                    openURL(url)
                } label: {
                    Image(systemName: "play.rectangle.fill")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Watch video")
            }
            Menu {
                Button("Move Up", systemImage: "arrow.up") { WorkoutService.move(entry, by: -1) }
                Button("Move Down", systemImage: "arrow.down") { WorkoutService.move(entry, by: 1) }
                Divider()
                Button("Remove Exercise", systemImage: "trash", role: .destructive) {
                    WorkoutService.remove(entry, in: context)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 32, height: 28)
                    .contentShape(Rectangle())
            }
        }
    }

    private var columnTitles: some View {
        HStack(spacing: SetRow.spacing) {
            Text("Set").frame(width: SetRow.labelWidth)
            Text("Previous").frame(maxWidth: .infinity)
            Text(unit.rawValue).frame(width: SetRow.weightWidth)
            Text("Reps").frame(width: SetRow.repsWidth)
            Text(effort.title).frame(width: SetRow.effortWidth)
            Image(systemName: "checkmark").frame(width: SetRow.checkWidth)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
    }
}

private struct SetRow: View {
    static let spacing: CGFloat = 6
    static let labelWidth: CGFloat = 30
    static let weightWidth: CGFloat = 62
    static let repsWidth: CGFloat = 46
    static let effortWidth: CGFloat = 46
    static let checkWidth: CGFloat = 36

    @Environment(\.modelContext) private var context
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @AppStorage(SettingsKey.effort) private var effort: EffortScale = .rpe
    @Bindable var set: SetEntry
    let label: String
    /// The matching set from the last time this exercise was done.
    let previous: SetEntry?

    var body: some View {
        HStack(spacing: Self.spacing) {
            Menu {
                Toggle("Warm-up Set", isOn: $set.isWarmup)
            } label: {
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(set.isWarmup ? Color.orange : Color.primary)
                    .frame(width: Self.labelWidth, height: 34)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
            }

            Button(action: usePrevious) {
                Text(previousText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
            .disabled(previous == nil)

            DecimalField(value: weightInUnit, placeholder: previous?.weight.map { Fmt.number(unit.fromKg($0)) } ?? "–")
                .modifier(CellStyle(width: Self.weightWidth, filled: !set.isDone))
                .accessibilityLabel("Weight")
            IntegerField(value: $set.reps, placeholder: previous?.reps.map(String.init) ?? "–")
                .modifier(CellStyle(width: Self.repsWidth, filled: !set.isDone))
                .accessibilityLabel("Reps")

            Menu {
                ForEach(effort.choices, id: \.self) { choice in
                    Button(Fmt.number(choice, maxDecimals: 1)) { set.rpe = effort.rpe(from: choice) }
                }
                if set.rpe != nil {
                    Divider()
                    Button("Clear", systemImage: "xmark", role: .destructive) { set.rpe = nil }
                }
            } label: {
                Text(set.rpe.map { effort.text(rpe: $0) } ?? "–")
                    .foregroundStyle(set.rpe == nil ? Color.secondary : Color.primary)
                    .modifier(CellStyle(width: Self.effortWidth, filled: !set.isDone))
            }
            .accessibilityLabel(effort.title)

            Button(action: toggleDone) {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(set.isDone ? Color.white : Color.secondary)
                    .frame(width: Self.checkWidth, height: 34)
                    .background(set.isDone ? Color.green : Color(.tertiarySystemFill),
                                in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(set.isDone ? "Mark set as not done" : "Mark set as done")
        }
        .font(.body.weight(.medium))
        .listRowBackground(set.isDone ? Color.green.opacity(0.14) : Color(.secondarySystemGroupedBackground))
        .sensoryFeedback(.success, trigger: set.isDone) { _, isDone in isDone }
    }

    private var weightInUnit: Binding<Double?> {
        Binding(
            get: { set.weight.map(unit.fromKg) },
            set: { set.weight = $0.map(unit.toKg) }
        )
    }

    private var previousText: String {
        guard let previous else { return "–" }
        var text = ""
        if let weight = previous.weight { text += "\(Fmt.number(unit.fromKg(weight))) \(unit.rawValue) × " }
        text += previous.reps.map(String.init) ?? "–"
        if let rpe = previous.rpe { text += " @\(effort.text(rpe: rpe))" }
        return text
    }

    private func usePrevious() {
        guard let previous else { return }
        set.weight = previous.weight
        set.reps = previous.reps
    }

    /// Ticking an empty row takes over last time's numbers, so repeating a
    /// workout is one tap per set when nothing changed.
    private func toggleDone() {
        if set.isDone {
            set.isDone = false
            return
        }
        if set.weight == nil, set.reps == nil, let previous {
            set.weight = previous.weight
        }
        if set.reps == nil { set.reps = previous?.reps }
        guard set.reps != nil else { return } // nothing to log yet
        set.isDone = true
        // A ticked set is the point of the app; don't leave it to autosave.
        try? context.save()
    }
}

private struct CellStyle: ViewModifier {
    let width: CGFloat
    let filled: Bool

    func body(content: Content) -> some View {
        content
            .frame(width: width, height: 34)
            .background(filled ? Color(.tertiarySystemFill) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
    }
}
