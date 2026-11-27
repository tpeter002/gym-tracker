import SwiftData
import SwiftUI

enum AppTab: Hashable {
    case home, history, exercises, body
}

/// App-wide navigation state: which tab is showing and whether the
/// in-progress workout sheet is up.
@MainActor
@Observable
final class AppRouter {
    var tab: AppTab = .home
    var showActiveWorkout = false
    /// Set when the user tries to start a workout while another is running.
    var conflict: StartRequest?

    enum StartRequest {
        case empty
        case repeating(Workout)
    }

    func start(_ request: StartRequest, in context: ModelContext) {
        if WorkoutService.activeWorkout(in: context) != nil {
            conflict = request
            return
        }
        begin(request, in: context)
    }

    func begin(_ request: StartRequest, in context: ModelContext) {
        switch request {
        case .empty: WorkoutService.startEmpty(in: context)
        case .repeating(let source): WorkoutService.startRepeat(of: source, in: context)
        }
        showActiveWorkout = true
    }
}

struct RootView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @Query(filter: #Predicate<Workout> { $0.endedAt == nil }, sort: \Workout.startedAt, order: .reverse)
    private var active: [Workout]
    @State private var router = AppRouter()

    var body: some View {
        TabView(selection: $router.tab) {
            HomeView()
                .tabItem { Label("Workout", systemImage: "dumbbell.fill") }
                .tag(AppTab.home)
            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                .tag(AppTab.history)
            ExerciseListView()
                .tabItem { Label("Exercises", systemImage: "list.bullet") }
                .tag(AppTab.exercises)
            BodyWeightView()
                .tabItem { Label("Body", systemImage: "scalemass.fill") }
                .tag(AppTab.body)
        }
        .sheet(isPresented: $router.showActiveWorkout) {
            if let workout = active.first {
                ActiveWorkoutView(workout: workout)
            }
        }
        .confirmationDialog(
            "You already have a workout in progress",
            isPresented: Binding(get: { router.conflict != nil }, set: { if !$0 { router.conflict = nil } }),
            titleVisibility: .visible,
            presenting: router.conflict
        ) { request in
            Button("Resume Current Workout") { router.showActiveWorkout = true }
            Button("Discard It and Start New", role: .destructive) {
                if let current = active.first { WorkoutService.delete(current, in: context) }
                router.begin(request, in: context)
            }
            Button("Cancel", role: .cancel) {}
        }
        .environment(router)
        // Never leave the sheet up with nothing to show in it.
        .onChange(of: active.isEmpty) { _, noneActive in
            if noneActive { router.showActiveWorkout = false }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active {
                VideoInbox.ingestShared(context)
                VideoInbox.analyzePending(context)
            } else {
                // Typed-in numbers that haven't been ticked off yet: iOS may not
                // bring a backgrounded app back.
                context.saveOrLog()
            }
        }
        .onOpenURL { VideoInbox.handle($0, context: context) }
    }
}
