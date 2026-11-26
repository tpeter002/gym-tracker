import Foundation

/// One exercise the analyzer found in a video.
struct ExerciseSuggestion: Codable, Identifiable, Hashable {
    var name: String
    /// Exact name of a library exercise when the analyzer recognised one.
    var libraryMatch: String?
    var muscleGroup: String?
    var equipment: String?
    /// Short how-to / cue, in the analyzer's words.
    var notes: String?
    /// Sets × reps when the video prescribes them.
    var setsReps: String?

    var id: String { name }
    var resolvedName: String { libraryMatch ?? name }

    enum CodingKeys: String, CodingKey {
        case name, notes, equipment
        case libraryMatch = "library_match"
        case muscleGroup = "muscle_group"
        case setsReps = "sets_reps"
    }
}

struct AnalysisResult: Codable {
    var title: String?
    var caption: String?
    var exercises: [ExerciseSuggestion]
}

/// Client for the small analyzer service in `server/` (download → frames → Claude).
enum VideoAnalyzer {
    enum Failure: LocalizedError {
        case notConfigured
        case badAddress
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Set the analyzer address in Settings first."
            case .badAddress: "The analyzer address in Settings isn't a valid URL."
            case .server(let message): message
            }
        }
    }

    static var serverAddress: String {
        (UserDefaults.standard.string(forKey: SettingsKey.analyzerURL) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static var isConfigured: Bool { !serverAddress.isEmpty }

    private static func endpoint(_ path: String) throws -> URL {
        var address = serverAddress
        guard !address.isEmpty else { throw Failure.notConfigured }
        if !address.contains("://") { address = "http://" + address }
        while address.hasSuffix("/") { address.removeLast() }
        guard let url = URL(string: address + path) else { throw Failure.badAddress }
        return url
    }

    static func isReachable() async -> Bool {
        guard let url = try? endpoint("/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    static func analyze(videoURL: String, knownExercises: [String]) async throws -> AnalysisResult {
        var request = URLRequest(url: try endpoint("/analyze"))
        request.httpMethod = "POST"
        request.timeoutInterval = 240 // download + frames + model call
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "url": videoURL,
            "known_exercises": knownExercises,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.server("No response from the analyzer.") }
        guard http.statusCode == 200 else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["detail"] as? String
            throw Failure.server(detail ?? "The analyzer returned an error (\(http.statusCode)).")
        }
        return try JSONDecoder().decode(AnalysisResult.self, from: data)
    }
}
