import Foundation
import SwiftData

/// Everything that changes a workout's shape lives here, so views stay declarative.
@MainActor
enum WorkoutService {
    static func defaultName(for date: Date = Date()) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<11: "Morning Workout"
        case 11..<14: "Midday Workout"
        case 14..<18: "Afternoon Workout"
        case 18..<23: "Evening Workout"
        default: "Night Workout"
        }
    }

    static func activeWorkout(in context: ModelContext) -> Workout? {
        var descriptor = FetchDescriptor<Workout>(predicate: #Predicate<Workout> { $0.endedAt == nil })
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    @discardableResult
    static func startEmpty(in context: ModelContext) -> Workout {
        let workout = Workout(name: defaultName())
        context.insert(workout)
        context.saveOrLog()
        return workout
    }

    /// Same exercises and set layout as `source`. Values are left empty on
    /// purpose: each row shows last time's numbers and takes them over when ticked.
    @discardableResult
    static func startRepeat(of source: Workout, in context: ModelContext) -> Workout {
        let workout = Workout(name: source.name)
        context.insert(workout)
        var order = 0
        for old in source.sortedEntries {
            guard let exercise = old.exercise else { continue }
            let entry = insertEntry(for: exercise, into: workout, order: order, context: context)
            for (index, oldSet) in old.sortedSets.enumerated() {
                insert(SetEntry(order: index, isWarmup: oldSet.isWarmup), into: entry, context: context)
            }
            order += 1
        }
        context.saveOrLog()
        return workout
    }

    static func add(_ exercise: Exercise, to workout: Workout, in context: ModelContext) {
        let order = (workout.entries.map(\.order).max() ?? -1) + 1
        // Mirror last time's set count so the "previous" column lines up.
        let previous = previousSets(for: exercise, excluding: workout)
        let entry = insertEntry(for: exercise, into: workout, order: order, context: context)
        for index in 0..<(previous.isEmpty ? 3 : previous.count) {
            let isWarmup = index < previous.count ? previous[index].isWarmup : false
            insert(SetEntry(order: index, isWarmup: isWarmup), into: entry, context: context)
        }
        context.saveOrLog()
    }

    static func addSet(to entry: WorkoutExercise, in context: ModelContext) {
        insert(SetEntry(order: (entry.sets.map(\.order).max() ?? -1) + 1), into: entry, context: context)
        context.saveOrLog()
    }

    /// Deletes a set whose row is on screen.
    static func delete(_ set: SetEntry, in context: ModelContext) {
        set.entry?.sets.removeAll { $0 === set }
        context.delete(set)
        saveOnceRowsAreGone(context)
    }

    /// Removes an exercise whose section is on screen.
    static func remove(_ entry: WorkoutExercise, in context: ModelContext) {
        entry.workout?.entries.removeAll { $0 === entry }
        context.delete(entry)
        saveOnceRowsAreGone(context)
    }

    /// SwiftData traps when a view reads a model whose delete has been saved, so
    /// the row is taken out of its list first and the save follows the animation.
    private static func saveOnceRowsAreGone(_ context: ModelContext) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: ModelContext.screenSettleNanoseconds)
            context.saveOrLog()
        }
    }

    // MARK: Creating linked models
    //
    // Two rules, both learned from finished workouts losing their exercises:
    // - Link models only after they are in the context. A relationship assigned in
    //   `init` isn't recorded as a change on the other side.
    // - Save before going back to the run loop. A `@Query` refetch refreshes
    //   unchanged models from the store and drops links the store hasn't seen,
    //   and the next save then writes that loss back.
    // Callers that create several models save once when they're done.

    @discardableResult
    static func insertEntry(for exercise: Exercise, into workout: Workout, order: Int, notes: String = "",
                            context: ModelContext) -> WorkoutExercise {
        let entry = WorkoutExercise(order: order, name: exercise.name, notes: notes)
        context.insert(entry)
        entry.workout = workout
        entry.exercise = exercise
        return entry
    }

    @discardableResult
    static func insert(_ set: SetEntry, into entry: WorkoutExercise, context: ModelContext) -> SetEntry {
        context.insert(set)
        set.entry = entry
        return set
    }

    /// Swaps an exercise with its neighbour (`offset` −1 = up, +1 = down).
    static func move(_ entry: WorkoutExercise, by offset: Int) {
        guard let entries = entry.workout?.sortedEntries,
              let index = entries.firstIndex(where: { $0 === entry }),
              entries.indices.contains(index + offset) else { return }
        let other = entries[index + offset]
        (entry.order, other.order) = (other.order, entry.order)
    }

    /// Completed sets from the most recent finished workout containing `exercise`.
    static func previousSets(for exercise: Exercise, excluding current: Workout?) -> [SetEntry] {
        let candidates = exercise.entries.filter { entry in
            guard let workout = entry.workout, workout.endedAt != nil, workout !== current else { return false }
            return entry.sets.contains(where: \.isDone)
        }
        let latest = candidates.max {
            ($0.workout?.startedAt ?? .distantPast) < ($1.workout?.startedAt ?? .distantPast)
        }
        return latest?.sortedSets.filter(\.isDone) ?? []
    }

    static func hasCompletedSets(_ workout: Workout) -> Bool {
        workout.entries.contains { $0.sets.contains(where: \.isDone) }
    }

    /// Drops unticked sets and empty exercises, then closes the workout.
    static func finish(_ workout: Workout, endedAt: Date = Date(), in context: ModelContext) {
        for entry in workout.entries {
            let unticked = entry.sets.filter { !$0.isDone }
            if unticked.count == entry.sets.count {
                context.delete(entry) // takes its sets with it
            } else {
                unticked.forEach { context.delete($0) }
            }
        }
        // Deletes show up in the relationship arrays once they're saved.
        context.saveOrLog()

        for (index, entry) in workout.sortedEntries.enumerated() {
            entry.order = index
            for (setIndex, set) in entry.sortedSets.enumerated() { set.order = setIndex }
            if let exercise = entry.exercise, exercise.wantToTry { exercise.wantToTry = false }
        }
        if workout.name.trimmingCharacters(in: .whitespaces).isEmpty {
            workout.name = defaultName(for: workout.startedAt)
        }
        workout.endedAt = endedAt
        context.saveOrLog()
    }

    static func delete(_ workout: Workout, in context: ModelContext) {
        context.delete(workout)
        context.saveOrLog()
    }
}
