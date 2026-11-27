#if DEBUG
import Foundation
import SwiftData

/// Sample history for screenshots and UI work. Launch with `-seedDemoData`;
/// does nothing once any workout exists.
@MainActor
enum DemoData {
    static func seed(_ context: ModelContext) {
        let existing = (try? context.fetchCount(FetchDescriptor<Workout>())) ?? 0
        guard existing == 0 else { return }
        let exercises = (try? context.fetch(FetchDescriptor<Exercise>())) ?? []
        func exercise(_ name: String) -> Exercise? { exercises.first { $0.name == name } }

        let plans: [(name: String, lifts: [(String, Double?, Int, Int)])] = [
            ("Push", [("Bench Press (Barbell)", 80, 8, 3), ("Overhead Press (Dumbbell)", 24, 10, 3),
                      ("Triceps Rope Pushdown (Cable)", 27.5, 12, 3)]),
            ("Pull", [("Pull Up", nil, 9, 3), ("Bent Over Row (Barbell)", 70, 8, 3),
                      ("Bicep Curl (Dumbbell)", 14, 12, 3)]),
            ("Legs", [("Squat (Barbell)", 100, 6, 3), ("Romanian Deadlift (Barbell)", 90, 8, 3),
                      ("Leg Extension (Machine)", 55, 12, 2)]),
        ]
        let calendar = Calendar.current
        for week in 0..<4 {
            for (index, plan) in plans.enumerated() {
                let daysAgo = (3 - week) * 7 + (4 - index * 2)
                guard let day = calendar.date(byAdding: .day, value: -daysAgo, to: Date()),
                      let start = calendar.date(bySettingHour: 18, minute: 10, second: 0, of: day) else { continue }
                let workout = Workout(name: plan.name, startedAt: start, endedAt: start.addingTimeInterval(62 * 60))
                context.insert(workout)
                for (order, lift) in plan.lifts.enumerated() {
                    guard let exercise = exercise(lift.0) else { continue }
                    let entry = WorkoutService.insertEntry(for: exercise, into: workout, order: order, context: context)
                    for setIndex in 0..<lift.3 {
                        let set = SetEntry(
                            order: setIndex,
                            weight: lift.1.map { $0 + Double(week) * 2.5 },
                            reps: lift.2 - setIndex,
                            rpe: 7.5 + Double(setIndex) * 0.5,
                            isDone: true
                        )
                        WorkoutService.insert(set, into: entry, context: context)
                    }
                }
            }
        }

        for day in stride(from: 56, through: 0, by: -4) {
            guard let date = calendar.date(byAdding: .day, value: -day, to: Date()) else { continue }
            context.insert(BodyWeight(date: date, kg: 84.2 - Double(56 - day) * 0.03 + (day % 8 == 0 ? 0.4 : -0.1)))
        }

        let video = SavedVideo(url: "https://www.youtube.com/shorts/demo", title: "3 cable moves for bigger rear delts")
        context.insert(video)
        video.analyzedAt = Date()
        for name in ["Face Pull (Cable)", "Reverse Fly (Cable)"] {
            if let found = exercise(name) { VideoInbox.link(found, to: video) }
        }
        context.saveOrLog()
    }
}
#endif
