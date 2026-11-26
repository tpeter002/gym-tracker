import SwiftData
import SwiftUI

@main
struct GymTrackerApp: App {
    private let container: ModelContainer

    init() {
        #if DEBUG
        if Self.usesThrowawayStore {
            // Settings live outside the database; clear them too.
            for key in [SettingsKey.unit, SettingsKey.effort, SettingsKey.analyzerURL] {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        #endif
        do {
            let schema = Schema([
                Exercise.self, Workout.self, WorkoutExercise.self, SetEntry.self,
                BodyWeight.self, SavedVideo.self,
            ])
            // Keep the database in the app's own container. The app group is only
            // the share extension's inbox; if its identifier ever has to change
            // (a different signing team), the workout history must not go with it.
            let configuration = ModelConfiguration(
                schema: schema,
                isStoredInMemoryOnly: Self.usesThrowawayStore,
                groupContainer: .none
            )
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            fatalError("Could not open the workout database: \(error)")
        }
        ExerciseLibrary.seedIfNeeded(container.mainContext)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-seedDemoData") {
            DemoData.seed(container.mainContext)
        }
        #endif
    }

    /// UI tests launch with `-uiTesting` so every run starts from the same data
    /// and default settings.
    private static var usesThrowawayStore: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-uiTesting")
        #else
        false
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(container)
    }
}
