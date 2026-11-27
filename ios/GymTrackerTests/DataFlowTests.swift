import SwiftData
import XCTest
@testable import GymTracker

/// The logging and import paths against a real (in-memory) SwiftData store.
@MainActor
final class DataFlowTests: XCTestCase {
    private var container: ModelContainer!
    private var context: ModelContext { container.mainContext }

    override func setUp() async throws {
        let schema = Schema([
            Exercise.self, Workout.self, WorkoutExercise.self, SetEntry.self,
            BodyWeight.self, SavedVideo.self,
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, groupContainer: .none)
        container = try ModelContainer(for: schema, configurations: configuration)
    }

    override func tearDown() async throws {
        container = nil
    }

    private func makeExercise(_ name: String, wantToTry: Bool = false) -> Exercise {
        let exercise = Exercise(name: name, muscle: .chest, equipment: .barbell)
        exercise.wantToTry = wantToTry
        context.insert(exercise)
        return exercise
    }

    /// Logs `sets` (weight kg, reps) for one exercise and finishes the workout.
    @discardableResult
    private func logWorkout(_ exercise: Exercise, sets: [(Double, Int)], daysAgo: Int) -> Workout {
        let start = Date().addingTimeInterval(-Double(daysAgo) * 86_400)
        let workout = Workout(name: "Session", startedAt: start)
        context.insert(workout)
        WorkoutService.add(exercise, to: workout, in: context)
        let entry = workout.sortedEntries[0]
        while entry.sets.count < sets.count { WorkoutService.addSet(to: entry, in: context) }
        for (set, values) in zip(entry.sortedSets, sets) {
            set.weight = values.0
            set.reps = values.1
            set.isDone = true
        }
        WorkoutService.finish(workout, endedAt: start.addingTimeInterval(3600), in: context)
        return workout
    }

    // MARK: Logging

    func testFinishKeepsOnlyTickedSets() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        let curl = makeExercise("Bicep Curl (Barbell)")
        let workout = WorkoutService.startEmpty(in: context)
        WorkoutService.add(bench, to: workout, in: context)
        WorkoutService.add(curl, to: workout, in: context)
        XCTAssertEqual(workout.sortedEntries.map(\.sets.count), [3, 3], "a new exercise starts with three empty sets")

        let benchSets = workout.sortedEntries[0].sortedSets
        benchSets[0].weight = 80; benchSets[0].reps = 8; benchSets[0].isDone = true
        benchSets[2].weight = 85; benchSets[2].reps = 5; benchSets[2].isDone = true
        XCTAssertNotNil(WorkoutService.activeWorkout(in: context))

        WorkoutService.finish(workout, in: context)

        XCTAssertNil(WorkoutService.activeWorkout(in: context))
        XCTAssertNotNil(workout.endedAt)
        XCTAssertEqual(workout.sortedEntries.map(\.displayName), ["Bench Press (Barbell)"],
                       "an exercise with no ticked sets is dropped")
        let kept = workout.sortedEntries[0].sortedSets
        XCTAssertEqual(kept.map(\.weight), [80, 85])
        XCTAssertEqual(kept.map(\.order), [0, 1], "set order is closed up after dropping the unticked one")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SetEntry>()), 2, "dropped sets are deleted, not orphaned")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<WorkoutExercise>()), 1)
    }

    func testRepeatCopiesLayoutAndOffersLastNumbers() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        logWorkout(bench, sets: [(70, 10), (75, 8)], daysAgo: 7)
        let latest = logWorkout(bench, sets: [(80, 8), (82.5, 6), (85, 4)], daysAgo: 2)

        let again = WorkoutService.startRepeat(of: latest, in: context)

        XCTAssertEqual(again.name, latest.name)
        XCTAssertNil(again.endedAt)
        let sets = again.sortedEntries[0].sortedSets
        XCTAssertEqual(sets.count, 3)
        XCTAssertTrue(sets.allSatisfy { $0.weight == nil && $0.reps == nil && !$0.isDone },
                      "repeated sets start empty; the row shows last time's numbers instead")
        let previous = WorkoutService.previousSets(for: bench, excluding: again)
        XCTAssertEqual(previous.map(\.weight), [80, 82.5, 85], "previous = the most recent finished session")
        XCTAssertEqual(previous.map(\.reps), [8, 6, 4])
    }

    /// Finishing deletes the unticked sets; the exercise link on what's left
    /// must survive that, or the workout can't be repeated. (The bug that once
    /// broke this needed a live `@Query` refetch between adding and finishing,
    /// so the UI test `testLogFinishAndRepeatWorkout` is the real guard.)
    func testFinishedWorkoutStaysLinkedToItsExercises() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        let row = makeExercise("Bent Over Row (Barbell)")
        logWorkout(bench, sets: [(80, 8), (80, 8), (80, 7)], daysAgo: 7)
        try context.save()

        let workout = WorkoutService.startEmpty(in: context)
        WorkoutService.add(bench, to: workout, in: context)
        WorkoutService.add(row, to: workout, in: context)
        for entry in workout.sortedEntries {
            let sets = entry.sortedSets
            sets[0].weight = 82.5; sets[0].reps = 8; sets[0].isDone = true
            sets[1].weight = 85; sets[1].reps = 5; sets[1].rpe = 8.5; sets[1].isDone = true
        }
        WorkoutService.finish(workout, in: context)

        XCTAssertEqual(workout.sortedEntries.map(\.sets.count), [2, 2])
        XCTAssertTrue(workout.sortedEntries[0].exercise === bench, "bench entry lost its exercise")
        XCTAssertTrue(workout.sortedEntries[1].exercise === row, "row entry lost its exercise")
        XCTAssertEqual(bench.entries.count, 2)

        let again = WorkoutService.startRepeat(of: workout, in: context)
        XCTAssertEqual(again.sortedEntries.map(\.displayName), ["Bench Press (Barbell)", "Bent Over Row (Barbell)"])
        XCTAssertEqual(again.sortedEntries.map(\.sets.count), [2, 2])
        XCTAssertEqual(WorkoutService.previousSets(for: bench, excluding: again).map(\.weight), [82.5, 85])
    }

    func testAddingAnExerciseMirrorsLastSetCount() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        logWorkout(bench, sets: [(80, 8), (80, 8), (80, 7), (80, 6)], daysAgo: 3)

        let workout = WorkoutService.startEmpty(in: context)
        WorkoutService.add(bench, to: workout, in: context)

        XCTAssertEqual(workout.sortedEntries[0].sets.count, 4)
    }

    func testFinishingClearsWantToTry() throws {
        let facePull = makeExercise("Face Pull (Cable)", wantToTry: true)
        let untouched = makeExercise("Reverse Fly (Cable)", wantToTry: true)

        logWorkout(facePull, sets: [(20, 15)], daysAgo: 0)

        XCTAssertFalse(facePull.wantToTry)
        XCTAssertTrue(untouched.wantToTry)
    }

    func testDeletingAWorkoutKeepsTheExercise() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        let workout = logWorkout(bench, sets: [(80, 8)], daysAgo: 1)

        WorkoutService.delete(workout, in: context)

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Workout>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SetEntry>()), 0, "sets go with their workout")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Exercise>()), 1)
        XCTAssertTrue(WorkoutService.previousSets(for: bench, excluding: nil).isEmpty)
    }

    // MARK: Strong import

    private let strongCSV = """
    Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
    2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",1,100.0,8,0,0,"","",8.5
    2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",2,105.0,6,0,0,"","",
    2023-03-01 18:05:10,"Push",1h 5m,"Zercher Squat (Barbell)",1,60.0,5,0,0,"","",
    2023-03-03 07:30:00,"Pull",45m,"Pull Up",1,0,10,0,0,"","",
    """

    func testStrongImportBuildsHistoryAndIsRepeatable() throws {
        let bench = makeExercise("Bench Press (Barbell)")
        let parsed = try StrongCSVParser.parse(strongCSV)

        let first = StrongImporter.apply(parsed, unit: .kg, context: context)

        XCTAssertEqual(first.workouts, 2)
        XCTAssertEqual(first.sets, 4)
        XCTAssertEqual(first.newExercises, 2, "Zercher Squat and Pull Up weren't in the store")
        let workouts = try context.fetch(FetchDescriptor<Workout>(sortBy: [SortDescriptor(\.startedAt)]))
        XCTAssertEqual(workouts.map(\.name), ["Push", "Pull"])
        XCTAssertEqual(workouts[0].duration, 3900)
        XCTAssertTrue(workouts[0].sortedEntries[0].exercise === bench, "known names reuse the existing exercise")
        XCTAssertEqual(workouts[0].sortedEntries[0].sortedSets.map(\.weight), [100, 105])
        XCTAssertEqual(workouts[0].sortedEntries[0].sortedSets.first?.rpe, 8.5)
        let zercher = try XCTUnwrap(workouts[0].sortedEntries[1].exercise)
        XCTAssertTrue(zercher.isCustom)
        XCTAssertEqual(zercher.muscle, .quads)
        XCTAssertEqual(zercher.equipment, .barbell)
        XCTAssertNil(WorkoutService.activeWorkout(in: context), "imported workouts are finished ones")

        let second = StrongImporter.apply(parsed, unit: .kg, context: context)

        XCTAssertEqual(second.workouts, 0)
        XCTAssertEqual(second.alreadyImported, 2)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Workout>()), 2)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SetEntry>()), 4)
    }

    func testStrongImportConvertsPoundsToKilograms() throws {
        let parsed = try StrongCSVParser.parse(strongCSV)

        _ = StrongImporter.apply(parsed, unit: .lb, context: context)

        let sets = try context.fetch(FetchDescriptor<SetEntry>())
        let heaviest = try XCTUnwrap(sets.compactMap(\.weight).max())
        XCTAssertEqual(heaviest, 105 * 0.45359237, accuracy: 0.01)
    }

    // MARK: Saved videos

    func testShareLinksAreStrippedOfTracking() {
        XCTAssertEqual(
            VideoInbox.canonical(URL(string: "https://www.instagram.com/reel/Cxyz123/?igsh=abc123&utm_source=ig")!),
            "https://www.instagram.com/reel/Cxyz123/"
        )
        XCTAssertEqual(
            VideoInbox.canonical(URL(string: "https://youtube.com/shorts/abc?si=tracking#frag")!),
            "https://youtube.com/shorts/abc"
        )
        XCTAssertEqual(
            VideoInbox.canonical(URL(string: "https://www.youtube.com/watch?v=abc&si=tracking&t=42")!),
            "https://www.youtube.com/watch?v=abc&t=42"
        )
    }

    func testLinkIsFoundInsideSharedText() {
        let shared = "Check this out 💪 https://www.tiktok.com/@coach/video/7300000000000000000?is_from_webapp=1 #gym"
        XCTAssertEqual(SharedInbox.firstURL(in: shared)?.host, "www.tiktok.com")
        XCTAssertNil(SharedInbox.firstURL(in: "no link here"))
    }

    /// Only a failure that can't have cost a model call may be retried by itself.
    func testOnlyConnectionFailuresCountAsNeverReachingTheAnalyzer() {
        let unreached: [URLError.Code] = [
            .cannotFindHost, .cannotConnectToHost, .notConnectedToInternet, .networkConnectionLost, .dnsLookupFailed,
        ]
        for code in unreached {
            XCTAssertTrue(VideoInbox.neverReachedAnalyzer(URLError(code)), "URLError code \(code.rawValue)")
        }

        XCTAssertFalse(VideoInbox.neverReachedAnalyzer(URLError(.timedOut)),
                       "the analysis may have run before the phone gave up waiting")
        XCTAssertFalse(VideoInbox.neverReachedAnalyzer(VideoAnalyzer.Failure.server("The video couldn't be downloaded.")))
        let unreadable = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not JSON"))
        XCTAssertFalse(VideoInbox.neverReachedAnalyzer(unreadable))
        XCTAssertFalse(VideoInbox.neverReachedAnalyzer(CancellationError()))
    }

    /// A link that is new always starts a preview fetch, so only the paths that
    /// end before it are covered here.
    func testSharingASavedLinkAgainKeepsTheVideoAndItsDate() throws {
        let firstShared = Date(timeIntervalSinceReferenceDate: 700_000_000)
        let saved = SavedVideo(url: "https://www.instagram.com/reel/Cxyz123/")
        saved.addedAt = firstShared
        context.insert(saved)
        try context.save()

        let again = VideoInbox.add("https://www.instagram.com/reel/Cxyz123/?igsh=abc123",
                                   sharedAt: Date(), context: context)

        XCTAssertTrue(again === saved, "the same clip under another share link is the same video")
        XCTAssertEqual(saved.addedAt, firstShared)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SavedVideo>()), 1)
        XCTAssertNil(VideoInbox.add("no link here", sharedAt: Date(), context: context))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SavedVideo>()), 1)
    }

    func testAdoptedExerciseTakesEquipmentFromItsNameWhenTheAnalyzerGivesNone() throws {
        let video = SavedVideo(url: "https://www.youtube.com/shorts/abc")
        context.insert(video)
        let unnamed = ExerciseSuggestion(name: "Zercher Carry (Kettlebell)")
        let named = ExerciseSuggestion(name: "Jefferson Curl (Barbell)", equipment: "dumbbell")

        let guessed = VideoInbox.adopt(unnamed, from: video, context: context)
        let given = VideoInbox.adopt(named, from: video, context: context)

        XCTAssertEqual(guessed.equipment, .kettlebell)
        XCTAssertEqual(given.equipment, .dumbbell, "what the analyzer says wins over the guess")
        XCTAssertTrue(guessed.wantToTry)
        XCTAssertTrue(guessed.savedVideo === video)
    }

    // MARK: Formatting

    func testSetTextWithAndWithoutWeight() {
        XCTAssertEqual(SetEntry(order: 0, weight: 80, reps: 8).text(in: .kg), "80 kg × 8")
        XCTAssertEqual(SetEntry(order: 0, reps: 12).text(in: .kg), "12 reps")
        XCTAssertEqual(SetEntry(order: 0, weight: 80).text(in: .kg), "80 kg × –")
        XCTAssertEqual(SetEntry(order: 0, weight: 45.359237, reps: 5).text(in: .lb), "100 lb × 5")
    }
}
