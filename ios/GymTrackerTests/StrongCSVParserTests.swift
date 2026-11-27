import XCTest
@testable import GymTracker

final class StrongCSVParserTests: XCTestCase {
    func testOlderCommaLayout() throws {
        let csv = """
        Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
        2023-03-01 18:05:10,"Push, heavy",1h 5m,"Bench Press (Barbell)",1,80.0,8,0,0,"","felt good",8.5
        2023-03-01 18:05:10,"Push, heavy",1h 5m,"Bench Press (Barbell)",2,82.5,6,0,0,"","felt good",
        2023-03-01 18:05:10,"Push, heavy",1h 5m,"Plank",1,0,0,0,60,"","felt good",
        2023-03-03 07:30:00,"Pull",45m,"Pull Up",1,0,10,0,0,"","",
        """
        let result = try StrongCSVParser.parse(csv)

        XCTAssertEqual(result.workouts.count, 2)
        XCTAssertNil(result.headerUnit)
        let push = result.workouts[0]
        XCTAssertEqual(push.name, "Push, heavy")
        XCTAssertEqual(push.duration, 3900)
        XCTAssertEqual(push.notes, "felt good")
        XCTAssertEqual(push.exercises.map(\.name), ["Bench Press (Barbell)", "Plank"])
        XCTAssertEqual(push.exercises[0].sets, [
            .init(weight: 80, reps: 8, rpe: 8.5),
            .init(weight: 82.5, reps: 6, rpe: nil),
        ])
        // Timed sets keep their seconds in the reps column.
        XCTAssertEqual(push.exercises[1].sets, [.init(weight: nil, reps: 60, rpe: nil)])
        // Bodyweight: weight 0 means "no added weight", not a 0 kg lift.
        XCTAssertEqual(result.workouts[1].exercises[0].sets, [.init(weight: nil, reps: 10, rpe: nil)])
        XCTAssertEqual(result.workouts[1].duration, 2700)
    }

    func testNewerSemicolonLayout() throws {
        let csv = """
        Workout #;Date;Workout Name;Duration (sec);Exercise Name;Set Order;Weight (kg);Reps;RPE;Distance (meters);Seconds;Notes;Workout Notes
        1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";W;60;5;;;;;
        1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";1;100;5;9;;;;
        1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";Rest Timer;;;;;180;;
        1;2024-05-02 17:45:11;"Legs";3720;"Squat (Barbell)";Note;;;;;;"belt on";
        1;2024-05-02 17:45:11;"Legs";3720;"Leg Press";1;180,5;12;;;;;
        """
        let result = try StrongCSVParser.parse(csv)

        XCTAssertEqual(result.headerUnit, .kg)
        XCTAssertEqual(result.workouts.count, 1)
        let legs = result.workouts[0]
        XCTAssertEqual(legs.duration, 3720)
        XCTAssertEqual(legs.exercises.count, 2)
        XCTAssertEqual(legs.exercises[0].notes, "belt on")
        XCTAssertEqual(legs.exercises[0].sets, [
            .init(weight: 60, reps: 5, rpe: nil, isWarmup: true),
            .init(weight: 100, reps: 5, rpe: 9),
        ])
        XCTAssertEqual(legs.exercises[1].sets, [.init(weight: 180.5, reps: 12, rpe: nil)])
        XCTAssertEqual(result.setCount, 3)
    }

    func testRejectsFilesThatAreNotStrongExports() {
        XCTAssertThrowsError(try StrongCSVParser.parse("name,email\nA,b@example.com")) { error in
            XCTAssertEqual(error as? StrongCSVParser.Failure,
                           .missingColumns(["Date", "Exercise Name", "Set Order", "Weight", "Reps"]))
        }
        XCTAssertThrowsError(try StrongCSVParser.parse("")) { error in
            XCTAssertEqual(error as? StrongCSVParser.Failure, .empty)
        }
    }

    func testQuotedFieldsMayContainDelimitersQuotesAndLineBreaks() {
        let rows = StrongCSVParser.records(in: "a,\"b,1\",\"say \"\"hi\"\"\"\r\n\"two\nlines\",x,y\n", delimiter: ",")
        XCTAssertEqual(rows, [["a", "b,1", "say \"hi\""], ["two\nlines", "x", "y"]])
    }

    func testDurationFormats() {
        XCTAssertEqual(StrongCSVParser.duration("1h 2m"), 3720)
        XCTAssertEqual(StrongCSVParser.duration("45m"), 2700)
        XCTAssertEqual(StrongCSVParser.duration("30s"), 30)
        XCTAssertEqual(StrongCSVParser.duration("3720"), 3720)
        XCTAssertNil(StrongCSVParser.duration(""))
    }

    /// Each of these parses as a number that an `Int` can't hold; converting
    /// one used to crash the import, or the History screen after it.
    func testGarbledNumbersAreTreatedAsMissing() throws {
        let csv = """
        Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
        2023-03-01 18:05:10,"Push",inf,"Bench Press (Barbell)",1,80.0,1e19,0,0,"","",
        2023-03-01 18:05:10,"Push",inf,"Bench Press (Barbell)",2,82.5,inf,0,0,"","",
        2023-03-01 18:05:10,"Push",inf,"Plank",1,0,0,0,1e19,"","",
        2023-03-01 18:05:10,"Push",inf,"Plank",2,0,inf,0,60,"","",
        """
        let result = try StrongCSVParser.parse(csv)

        let push = try XCTUnwrap(result.workouts.first)
        XCTAssertNil(push.duration)
        XCTAssertEqual(push.exercises.map(\.name), ["Bench Press (Barbell)", "Plank"])
        XCTAssertEqual(push.exercises[0].sets, [
            .init(weight: 80, reps: nil, rpe: nil),
            .init(weight: 82.5, reps: nil, rpe: nil),
        ], "the weight is still worth keeping")
        XCTAssertEqual(push.exercises[1].sets, [.init(weight: nil, reps: 60, rpe: nil)])
        XCTAssertEqual(result.skippedRows, 1, "the plank row with nothing usable in it")
    }

    func testDurationRejectsWhatCannotBeAWorkoutLength() {
        XCTAssertNil(StrongCSVParser.duration("inf"))
        XCTAssertNil(StrongCSVParser.duration("nan"))
        XCTAssertNil(StrongCSVParser.duration("1e19"))
        XCTAssertNil(StrongCSVParser.duration("99999999999999999999h"))
        XCTAssertNil(StrongCSVParser.duration("-5"))
        XCTAssertEqual(StrongCSVParser.duration("100000"), 100_000)
    }

    func testMuscleGuessPrefersTheMoreSpecificKeyword() {
        XCTAssertEqual(StrongImporter.guessMuscle("Seated Leg Curl (Machine)"), .hamstrings)
        XCTAssertEqual(StrongImporter.guessMuscle("Hammer Curl (Dumbbell)"), .biceps)
        XCTAssertEqual(StrongImporter.guessMuscle("Upright Row (Barbell)"), .shoulders)
        XCTAssertEqual(StrongImporter.guessMuscle("Close Grip Bench Press (Barbell)"), .triceps)
        XCTAssertEqual(StrongImporter.guessEquipment("Bench Press (Smith Machine)"), .machine)
        XCTAssertEqual(StrongImporter.guessEquipment("Pull Up"), .other)
    }
}
