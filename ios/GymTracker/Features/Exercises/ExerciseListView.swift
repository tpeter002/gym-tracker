import SwiftData
import SwiftUI

/// The exercise library: built-ins plus your own, searchable.
struct ExerciseListView: View {
    @Query(sort: \Exercise.name) private var exercises: [Exercise]
    @State private var query = ""
    @State private var muscle: MuscleGroup?
    @State private var showEditor = false

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        let results = ExerciseSearch.filter(exercises, query: query, muscle: muscle)

        NavigationStack {
            List {
                MuscleFilterBar(selection: $muscle)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)

                ForEach(results) { exercise in
                    NavigationLink {
                        ExerciseDetailView(exercise: exercise)
                    } label: {
                        ExerciseRowLabel(exercise: exercise)
                    }
                }

                // The + button is hidden while searching, and "not found" is the
                // moment you want to add your own.
                if !trimmedQuery.isEmpty {
                    Button {
                        showEditor = true
                    } label: {
                        Label("Create “\(trimmedQuery)”", systemImage: "plus.circle.fill")
                    }
                }

                if results.isEmpty, trimmedQuery.isEmpty {
                    ContentUnavailableView("No Exercises", systemImage: "dumbbell",
                                           description: Text("Nothing in this muscle group yet."))
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            // Always shown: by default iOS 27 tucks the field away until you pull the list down.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search exercises")
            .autocorrectionDisabled()
            .navigationTitle("Exercises")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showEditor = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New exercise")
                }
            }
            .sheet(isPresented: $showEditor) {
                ExerciseEditorView(suggestedName: trimmedQuery)
            }
        }
    }
}

/// Create a custom exercise, or edit an existing one.
struct ExerciseEditorView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var existing: [Exercise]

    private let exercise: Exercise?
    private let onSave: (Exercise) -> Void
    @State private var name: String
    @State private var muscle: MuscleGroup
    @State private var equipment: Equipment
    @State private var notes: String
    @State private var videoURL: String

    init(exercise: Exercise? = nil, suggestedName: String = "", onSave: @escaping (Exercise) -> Void = { _ in }) {
        self.exercise = exercise
        self.onSave = onSave
        _name = State(initialValue: exercise?.name ?? suggestedName)
        _muscle = State(initialValue: exercise?.muscle
            ?? (suggestedName.isEmpty ? .other : StrongImporter.guessMuscle(suggestedName)))
        _equipment = State(initialValue: exercise?.equipment ?? StrongImporter.guessEquipment(suggestedName))
        _notes = State(initialValue: exercise?.notes ?? "")
        _videoURL = State(initialValue: exercise?.videoURL ?? "")
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    /// Two exercises with the same name would be indistinguishable in search.
    private var isDuplicate: Bool {
        let key = Exercise.normalize(trimmedName)
        return existing.contains { $0 !== exercise && Exercise.normalize($0.name) == key }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                } footer: {
                    if isDuplicate {
                        Text("An exercise with this name already exists.")
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Picker("Muscle group", selection: $muscle) {
                        ForEach(MuscleGroup.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Equipment", selection: $equipment) {
                        ForEach(Equipment.allCases) { Text($0.title).tag($0) }
                    }
                }
                Section("Notes") {
                    TextField("Cues, setup, how it should feel…", text: $notes, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section("Video link") {
                    TextField("Video link", text: $videoURL, prompt: Text(verbatim: "https://…"))
                        .accessibilityLabel("Video link")
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle(exercise == nil ? "New Exercise" : "Edit Exercise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .fontWeight(.semibold)
                        .disabled(trimmedName.isEmpty || isDuplicate)
                }
            }
        }
    }

    private func save() {
        let target: Exercise
        if let exercise {
            target = exercise
            target.name = trimmedName
            target.muscle = muscle
            target.equipment = equipment
            // History rows keep their own copy of the name; keep them in step.
            for entry in target.entries { entry.exerciseName = trimmedName }
        } else {
            target = Exercise(name: trimmedName, muscle: muscle, equipment: equipment, isCustom: true)
            context.insert(target)
        }
        target.notes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = videoURL.trimmingCharacters(in: .whitespacesAndNewlines)
        target.videoURL = link.isEmpty ? nil : link
        context.saveOrLog()
        onSave(target)
        dismiss()
    }
}
