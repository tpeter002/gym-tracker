import XCTest

/// Shares a link from Safari through the system share sheet and checks that
/// it arrives in the app. This is the path Instagram / TikTok / YouTube use.
final class ShareExtensionUITests: XCTestCase {
    func testSharingFromSafariSavesTheLink() throws {
        continueAfterFailure = false
        // Launch the app once before touching Safari. The test runner installs it
        // on first launch, and an install in progress kills the app's extensions —
        // sharing while that happens fails for reasons that have nothing to do with us.
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Saved Videos"].waitForExistence(timeout: 10))
        app.terminate()

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        safari.launch()
        XCUIDevice.shared.system.open(URL(string: "https://example.com/reel/share-test?igsh=abc123")!)
        _ = safari.wait(for: .runningForeground, timeout: 10)

        let tip = safari.buttons["xmark.circle.fill"]
        if tip.waitForExistence(timeout: 4) { tip.tap() }

        // Safari keeps Share in its "…" menu; the button is named differently on iOS 26 and 27.
        let more = safari.buttons.matching(
            NSPredicate(format: "identifier == %@ OR label IN %@", "MoreMenuButton", ["More", "Továbbiak"])
        ).firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 5), "Safari's menu button")
        more.tap()
        let share = safari.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Share")).firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 5), "Share item in Safari's menu")
        share.tap()

        let target = safari.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Gym Tracker")).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 8), "Gym Tracker should be offered in the share sheet")
        target.tap()
        // The extension confirms and closes itself; Safari is usable again.
        XCTAssertTrue(more.waitForExistence(timeout: 8))

        // Next time the app comes to the front it collects the link —
        // without the per-share tracking parameter.
        app.launch()
        app.staticTexts["Saved Videos"].tap()
        let row = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "example.com ·")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8), "the shared link should be listed")
        row.tap()
        XCTAssertTrue(app.buttons["Open in example.com"].waitForExistence(timeout: 5))
    }
}
