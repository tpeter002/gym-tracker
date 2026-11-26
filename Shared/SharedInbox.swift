import Foundation

/// Hand-off between the share extension and the app. The extension appends
/// links here; the app drains them the next time it becomes active.
enum SharedInbox {
    static let appGroup = "group.com.torokpeter.gymtracker"
    private static let key = "pendingLinks"

    struct Item: Codable {
        var url: String
        var date: Date
    }

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    private static func load(_ defaults: UserDefaults) -> [Item] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([Item].self, from: data)) ?? []
    }

    /// Returns false when the shared container is unavailable, so the
    /// extension can tell the user the link was not saved.
    @discardableResult
    static func append(_ url: URL) -> Bool {
        guard let defaults else { return false }
        var items = load(defaults)
        items.append(Item(url: url.absoluteString, date: Date()))
        guard let data = try? JSONEncoder().encode(items) else { return false }
        defaults.set(data, forKey: key)
        return true
    }

    static func drain() -> [Item] {
        guard let defaults else { return [] }
        let items = load(defaults)
        if !items.isEmpty { defaults.removeObject(forKey: key) }
        return items
    }

    /// First http(s) link in a piece of shared or pasted text. Apps like
    /// TikTok share "Check this out! https://…" rather than a bare URL.
    static func firstURL(in text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        for match in detector.matches(in: trimmed, options: [], range: range) {
            if let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                return url
            }
        }
        return nil
    }
}
