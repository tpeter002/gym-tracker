import XCTest

/// Walks the main flows in the simulator. Every test starts from the same
/// throwaway database: the built-in library plus the demo history
/// (Push / Pull / Legs for four weeks, one saved video).
final class GymTrackerUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = [
            "-uiTesting", "-seedDemoData",
            // Number and date formats follow the region; pin them.
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
    }

    // MARK: Helpers

    /// Saves a screenshot to the test report, and to `SHOTS_DIR` when set
    /// (`TEST_RUNNER_SHOTS_DIR=/some/dir xcodebuild test …`).
    private func snap(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        if let directory = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
            try? shot.pngRepresentation.write(to: file)
        }
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func labelled(_ query: XCUIElementQuery, _ label: String) -> XCUIElementQuery {
        query.matching(NSPredicate(format: "label == %@", label))
    }

    /// A text input by its accessibility label; multi-line SwiftUI fields are text views.
    private func field(_ label: String) -> XCUIElement {
        let inputs = [XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue]
        return app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ AND elementType IN %@", label, inputs))
            .firstMatch
    }

    private func appear(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 8,
                        file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) should be on screen", file: file, line: line)
    }

    private func text(containing fragment: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    /// Confirmation dialogs repeat the label of the button that opened them.
    /// While the dialog is up, its own button is the only one that can be hit.
    private func confirm(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let matches = labelled(app.buttons, label)
        let deadline = Date().addingTimeInterval(8)
        repeat {
            if let button = matches.allElementsBoundByIndex.reversed().first(where: \.isHittable) {
                button.tap()
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        } while Date() < deadline
        XCTFail("“\(label)” should be tappable in the dialog", file: file, line: line)
    }

    private func addExercise(search: String, pick name: String) {
        let add = app.buttons["Add Exercise"]
        appear(add, "Add Exercise")
        add.tap()
        let field = app.searchFields["Search exercises"]
        appear(field, "exercise search field")
        field.tap()
        field.typeText(search)
        let row = app.staticTexts[name]
        appear(row, "search result \(name)")
        row.tap()
        // Still searching, keyboard up: the button has to be reachable right here.
        app.buttons["Add 1 Exercise"].tap()
    }

    // MARK: Tests

    func testLogFinishAndRepeatWorkout() {
        snap("01-home")
        app.buttons["Start Empty Workout"].tap()
        // "bb" is the search alias for barbell.
        addExercise(search: "bench bb", pick: "Bench Press (Barbell)")

        let weights = labelled(app.textFields, "Weight")
        let reps = labelled(app.textFields, "Reps")
        let open = labelled(app.buttons, "Mark set as done")
        let done = labelled(app.buttons, "Mark set as not done")
        appear(weights.firstMatch, "weight field")
        XCTAssertEqual(weights.count, 3, "last Push session had three bench sets, so three rows are offered")
        // Last session's first set: 87.5 kg × 8 @ RPE 7.5.
        appear(app.buttons["87.5 kg × 8 @7.5"], "previous numbers for set 1")
        snap("02-workout-empty-sets")

        // Set 1: tick it untouched — it takes over last time's numbers.
        open.firstMatch.tap()
        XCTAssertEqual(done.count, 1)
        XCTAssertEqual(weights.element(boundBy: 0).value as? String, "87.5")
        XCTAssertEqual(reps.element(boundBy: 0).value as? String, "8")

        // Set 2: type new numbers and an RPE, then tick straight from the keyboard.
        weights.element(boundBy: 1).tap()
        weights.element(boundBy: 1).typeText("90")
        reps.element(boundBy: 1).tap()
        reps.element(boundBy: 1).typeText("5")
        labelled(app.buttons, "RPE").element(boundBy: 1).tap()
        app.buttons["8.5"].tap()
        open.firstMatch.tap()
        XCTAssertEqual(done.count, 2)
        snap("03-workout-two-sets-done")

        // Set 3 stays open, so finishing asks first and then drops it.
        app.buttons["Finish"].tap()
        appear(app.staticTexts["Finish workout?"], "finish confirmation")
        confirm("Finish")

        // Lands on History with the new workout on top.
        appear(app.navigationBars["History"], "History screen")
        let summary = app.staticTexts["2 × Bench Press (Barbell)"]
        appear(summary, "the finished workout with its two ticked sets")
        snap("04-history")

        summary.tap()
        appear(app.staticTexts["87.5 kg × 8"], "set 1 in the workout detail")
        appear(app.staticTexts["90 kg × 5"], "set 2 in the workout detail")
        appear(app.staticTexts["RPE 8.5"], "RPE of set 2")
        snap("05-workout-detail")

        // Repeat it: same exercise, two rows, offering what was just logged.
        app.buttons["Repeat Workout"].tap()
        appear(app.buttons["90 kg × 5 @8.5"], "previous numbers from the workout just finished")
        XCTAssertEqual(weights.count, 2)
        open.firstMatch.tap()
        XCTAssertEqual(weights.element(boundBy: 0).value as? String, "87.5")
        snap("06-repeat-workout")

        app.buttons["Discard Workout"].tap()
        appear(app.staticTexts["Discard this workout?"], "discard confirmation")
        confirm("Discard Workout")
        appear(app.buttons["Repeat Workout"], "the workout detail again once the sheet is gone")
        app.tabBars.buttons["Workout"].tap()
        appear(app.buttons["Start Empty Workout"], "start button — no workout is in progress any more")
    }

    func testStartingASecondWorkoutAsksFirst() {
        app.buttons["Start Empty Workout"].tap()
        addExercise(search: "pull up", pick: "Pull Up")
        app.buttons["Minimise"].tap()
        appear(app.staticTexts["Resume"], "resume card on the home screen")
        snap("07-home-workout-in-progress")

        // Demo history ends with Legs; try to repeat it while one is running.
        text(containing: "Squat (Barbell)").tap()
        app.buttons["Repeat Workout"].tap()
        appear(app.staticTexts["You already have a workout in progress"], "conflict dialog")
        app.buttons["Discard It and Start New"].tap()

        appear(app.staticTexts["Squat (Barbell)"], "the repeated Legs workout")
        XCTAssertFalse(app.staticTexts["Pull Up"].exists, "the discarded workout is gone")
        snap("08-repeated-legs")
        app.swipeUp() // the list only builds the rows that are on screen
        appear(app.staticTexts["Leg Extension (Machine)"], "its last exercise")
    }

    func testCreateAndFindCustomExercise() {
        app.tabBars.buttons["Exercises"].tap()
        let search = app.searchFields["Search exercises"]
        appear(search, "search field")
        search.tap()
        search.typeText("db curl")
        appear(app.staticTexts["Bicep Curl (Dumbbell)"], "alias search result")
        snap("09-exercise-search")

        // Not in the library: create it straight from the search.
        search.buttons["Clear text"].tap()
        search.typeText("Zercher Carry")
        let create = app.buttons["Create “Zercher Carry”"]
        appear(create, "create row for an unknown name")
        create.tap()
        appear(app.navigationBars["New Exercise"], "exercise editor")
        XCTAssertEqual(app.textFields["Name"].value as? String, "Zercher Carry", "the search text is carried over")
        app.buttons["Save"].tap()
        appear(app.staticTexts["Zercher Carry"], "the new custom exercise in the results")
    }

    func testToTryExercisesLeadThePicker() {
        appear(app.staticTexts["Face Pull (Cable)"], "to-try exercise on the home screen")
        app.buttons["Start Empty Workout"].tap()
        app.buttons["Add Exercise"].tap()
        appear(app.staticTexts["To try · from your videos"], "to-try section in the picker")
        snap("10-picker-to-try")
        app.staticTexts["Face Pull (Cable)"].firstMatch.tap()
        app.buttons["Add 1 Exercise"].tap()

        // Never done before: three empty rows, nothing to take over.
        let weights = labelled(app.textFields, "Weight")
        let reps = labelled(app.textFields, "Reps")
        appear(weights.firstMatch, "weight field")
        XCTAssertEqual(weights.count, 3)
        weights.firstMatch.tap()
        weights.firstMatch.typeText("22.5")
        reps.firstMatch.tap()
        reps.firstMatch.typeText("15")
        labelled(app.buttons, "Mark set as done").firstMatch.tap()
        app.buttons["Finish"].tap()
        confirm("Finish")

        // Done once, so it's no longer waiting on the to-try list.
        appear(app.navigationBars["History"], "History screen")
        app.tabBars.buttons["Workout"].tap()
        appear(app.buttons["Start Empty Workout"], "home screen")
        XCTAssertFalse(app.staticTexts["Face Pull (Cable)"].exists)
        XCTAssertTrue(app.staticTexts["Reverse Fly (Cable)"].exists)
    }

    func testSavedVideoAndManualExercise() {
        app.staticTexts["Saved Videos"].tap()
        appear(app.staticTexts["3 cable moves for bigger rear delts"], "the demo video")
        app.buttons["Add link"].tap()
        let link = field("Video link")
        appear(link, "link field")
        snap("11a-add-video-link")
        link.tap()
        link.typeText("https://www.instagram.com/reel/Cxyz123/?igsh=abc123")
        app.buttons["Save"].tap()
        // Stored without the per-share tracking parameter, shown by source.
        let row = text(containing: "Instagram")
        appear(row, "the new Instagram video")
        snap("11-saved-videos")

        row.tap()
        appear(app.buttons["Add Exercise Manually"], "manual fallback when no analyzer is set up")
        snap("12-video-detail")
    }

    /// Needs an analyzer to talk to, so it only runs when one is named:
    /// `TEST_RUNNER_ANALYZER_URL=http://localhost:8787 xcodebuild test …`
    /// (`TEST_RUNNER_ANALYZER_VIDEO` picks the clip). The simulator shares the Mac's network.
    func testAnalyzedVideoFillsTheToTryList() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ANALYZER_URL"], !address.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_ANALYZER_URL to run against an analyzer.")
        }
        // The default is just a short public clip; against the real analyzer
        // pass a workout short, or nothing will be found in it.
        let clip = environment["ANALYZER_VIDEO"] ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw"

        // Start without the demo video so everything on the list comes from this one.
        app.terminate()
        app.launchArguments.removeAll { $0 == "-seedDemoData" }
        app.launch()

        app.buttons["Settings"].tap()
        let addressField = field("Analyzer address")
        appear(addressField, "analyzer address field")
        addressField.tap()
        addressField.typeText(address)
        app.buttons["Test Connection"].tap()
        appear(app.staticTexts["Connected"], "analyzer reachable")
        snap("16-analyzer-connected")
        app.buttons["Done"].tap()

        app.staticTexts["Saved Videos"].tap()
        app.buttons["Add Link"].firstMatch.tap()
        let link = field("Video link")
        appear(link, "link field")
        link.tap()
        link.typeText(clip)
        app.buttons["Save"].tap()

        // Nothing else to do: the analysis runs by itself and its exercises
        // are put on the to-try list.
        let added = text(containing: "added")
        appear(added, "“N exercises added” on the video row", timeout: 240)
        snap("17-video-analyzed")
        added.tap()
        appear(app.staticTexts["On your list"], "exercises listed on the video")
        snap("18-video-detail-analyzed")

        app.navigationBars.buttons.firstMatch.tap()
        app.navigationBars.buttons.firstMatch.tap()
        appear(app.staticTexts["To try"].firstMatch, "to-try badge on the home screen")
        snap("19-home-to-try")
        app.buttons["Start Empty Workout"].tap()
        app.buttons["Add Exercise"].tap()
        appear(app.staticTexts["To try · from your videos"], "to-try section in the exercise picker")
        snap("20-picker-from-video")
    }

    /// Goes through the real document picker, so it needs a Strong export in the
    /// simulator's Files app ("On My iPhone"). Name it to run the test:
    /// `TEST_RUNNER_STRONG_CSV=strong-export xcodebuild test …`
    func testImportStrongExportFromFiles() throws {
        guard let fileName = ProcessInfo.processInfo.environment["STRONG_CSV"], !fileName.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_STRONG_CSV to the name of a CSV in the simulator's Files app.")
        }
        app.terminate()
        app.launchArguments.removeAll { $0 == "-seedDemoData" }
        app.launch()

        app.buttons["Settings"].tap()
        app.staticTexts["Import from Strong"].tap()
        app.buttons["Choose CSV File…"].tap()

        let file = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", fileName)).firstMatch
        if !file.waitForExistence(timeout: 6) {
            // The picker opened on Recents; the file is under Browse.
            let browse = app.buttons.matching(NSPredicate(format: "label IN %@", ["Browse", "Tallózás"])).firstMatch
            if browse.exists { browse.tap() }
        }
        appear(file, "\(fileName) in the document picker")
        file.tap()

        appear(app.staticTexts["Found in the file"], "preview of the parsed export")
        snap("21-strong-preview")
        let importButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Import ")).firstMatch
        appear(importButton, "import button")
        importButton.tap()
        appear(text(containing: "Imported "), "import summary")
        snap("22-strong-imported")

        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Done"].tap()
        app.tabBars.buttons["History"].tap()
        appear(app.navigationBars["History"], "History screen")
        XCTAssertFalse(app.staticTexts["No Workouts Yet"].exists)
        snap("23-history-after-import")
    }

    func testLogBodyWeight() {
        app.tabBars.buttons["Body"].tap()
        appear(app.navigationBars["Body Weight"], "Body Weight screen")
        snap("13-body-weight")
        app.buttons["Log weight"].tap()
        let weight = field("Body weight")
        appear(weight, "weight field")
        weight.tap()
        weight.typeText("83.4")
        app.buttons["Save"].tap()
        appear(text(containing: "83.4 kg"), "the new weigh-in")
    }

    func testSettingsSwitchUnitsAndEffortScale() {
        app.buttons["Settings"].tap()
        appear(app.navigationBars["Settings"], "Settings")
        snap("14-settings")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Weight unit")).firstMatch.tap()
        app.buttons["lb"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Effort scale")).firstMatch.tap()
        app.buttons["RIR"].tap()
        app.buttons["Done"].tap()

        // Demo Legs: squat 107.5 kg × 6 @ RPE 7.5 → 237 lb, 2.5 RIR.
        text(containing: "Squat (Barbell)").tap()
        appear(text(containing: "lb × 6"), "weights shown in pounds")
        appear(app.staticTexts["2.5 RIR"], "effort shown as reps in reserve")
        snap("15-detail-in-lb-rir")
    }
}
