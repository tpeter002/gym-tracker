import SwiftData
import SwiftUI

/// Searchable multi-select list for adding exercises to a workout. Exercises
/// saved from videos but not tried yet sit on top so they don't get forgotten.
struct ExercisePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Exercise.name) private var exercises: [Exercise]
    @State private var query = ""
    @State private var muscle: MuscleGroup?
    @State private var selection: [Exercise] = []
    @State private var showEditor = false
    var allowsMultiple = true
    let onAdd: ([Exercise]) -> Void

    private var isBrowsing: Bool { query.trimmingCharacters(in: .whitespaces).isEmpty && muscle == nil }

    var body: some View {
        let results = ExerciseSearch.filter(exercises, query: query, muscle: muscle)
        let toTry = exercises.filter(\.wantToTry)

        NavigationStack {
            List {
                MuscleFilterBar(selection: $muscle)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)

                if isBrowsing, !toTry.isEmpty {
                    Section("To try · from your videos") {
                        ForEach(toTry) { row(for: $0) }
                    }
                }

                Section(isBrowsing ? "All exercises" : "") {
                    ForEach(results) { row(for: $0) }
                    if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button {
                            showEditor = true
                        } label: {
                            Label("Create “\(query.trimmingCharacters(in: .whitespaces))”", systemImage: "plus.circle.fill")
                        }
                    }
                }
            }
            .listStyle(.plain)
            // Down here rather than in the navigation bar: the bar is hidden
            // while the search field is active, which is exactly when you pick.
            .safeAreaInset(edge: .bottom) {
                if allowsMultiple, !selection.isEmpty {
                    Button {
                        onAdd(selection)
                        dismiss()
                    } label: {
                        Text(selection.count == 1 ? "Add 1 Exercise" : "Add \(selection.count) Exercises")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search exercises")
            .autocorrectionDisabled()
            .navigationTitle("Add Exercise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showEditor = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New exercise")
                }
            }
            .sheet(isPresented: $showEditor) {
                ExerciseEditorView(suggestedName: query.trimmingCharacters(in: .whitespaces)) { created in
                    choose(created)
                    query = ""
                }
            }
        }
    }

    private func row(for exercise: Exercise) -> some View {
        let isSelected = selection.contains { $0 === exercise }
        return Button {
            choose(exercise)
        } label: {
            HStack {
                ExerciseRowLabel(exercise: exercise)
                Spacer()
                if allowsMultiple {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? Color.accentColor : Color(.tertiaryLabel))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ exercise: Exercise) {
        guard allowsMultiple else {
            onAdd([exercise])
            dismiss()
            return
        }
        if let index = selection.firstIndex(where: { $0 === exercise }) {
            selection.remove(at: index)
        } else {
            selection.append(exercise)
        }
    }
}
