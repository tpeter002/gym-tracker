import Foundation
import LinkPresentation
import SwiftData
import UIKit

/// Turns shared / pasted links into `SavedVideo`s and enriches them.
@MainActor
enum VideoInbox {
    /// Links already sent to the analyzer since launch. One that can't be
    /// downloaded shouldn't be retried every time the app comes to the front.
    private static var attempted: Set<String> = []
    private static var isSweeping = false

    /// Pulls in whatever the share extension collected since the last launch.
    static func ingestShared(_ context: ModelContext) {
        for item in SharedInbox.drain() {
            add(item.url, context: context)
        }
    }

    /// Analyzes saved videos that haven't been yet — typically ones shared while
    /// the Mac running the analyzer was out of reach.
    static func analyzePending(_ context: ModelContext) {
        guard VideoAnalyzer.isConfigured, !isSweeping else { return }
        let all = (try? context.fetch(FetchDescriptor<SavedVideo>(sortBy: [SortDescriptor(\.addedAt)]))) ?? []
        let waiting = all.filter { $0.analyzedAt == nil && !attempted.contains($0.url) }
        guard !waiting.isEmpty else { return }
        isSweeping = true
        Task {
            defer { isSweeping = false }
            guard await VideoAnalyzer.isReachable() else { return }
            for video in waiting where isLive(video) && video.analyzedAt == nil {
                attempted.insert(video.url)
                await analyze(video, context: context)
            }
        }
    }

    /// False once the video has been deleted; reading or writing it then traps.
    private static func isLive(_ video: SavedVideo) -> Bool {
        video.modelContext != nil && !video.isDeleted
    }

    /// `gymtracker://add?url=…` — lets an iOS Shortcut hand over links too.
    static func handle(_ url: URL, context: ModelContext) {
        guard url.scheme == "gymtracker", url.host == "add",
              let link = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "url" })?.value else { return }
        add(link, context: context)
    }

    @discardableResult
    static func add(_ raw: String, context: ModelContext) -> SavedVideo? {
        guard let url = SharedInbox.firstURL(in: raw) else { return nil }
        let link = canonical(url)
        let all = (try? context.fetch(FetchDescriptor<SavedVideo>())) ?? []
        if let existing = all.first(where: { $0.url == link }) { return existing }

        let video = SavedVideo(url: link)
        context.insert(video)
        try? context.save()
        attempted.insert(link)
        Task {
            await fetchPreview(for: video)
            guard isLive(video) else { return }
            await analyze(video, context: context)
        }
        return video
    }

    /// Share links carry per-share tracking parameters (`igsh`, `si`, `utm_*`…);
    /// dropping them keeps the same clip from being saved twice.
    static func canonical(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        let keep: Set<String> = ["v", "list", "t"]
        let kept = components.queryItems?.filter { keep.contains($0.name) } ?? []
        components.queryItems = kept.isEmpty ? nil : kept
        components.fragment = nil
        return components.url?.absoluteString ?? url.absoluteString
    }

    /// Title and thumbnail from the page's own preview metadata. Best effort:
    /// Instagram in particular often serves a login wall instead.
    static func fetchPreview(for video: SavedVideo) async {
        guard let url = URL(string: video.url) else { return }
        let provider = LPMetadataProvider()
        provider.timeout = 15
        guard let metadata = try? await provider.startFetchingMetadata(for: url), isLive(video) else { return }
        if video.title.isEmpty, let title = metadata.title, !title.isEmpty {
            video.title = title
        }
        if video.thumbnail == nil, let imageProvider = metadata.imageProvider,
           let image = await loadImage(from: imageProvider), isLive(video) {
            video.thumbnail = image.preparingThumbnail(of: thumbnailSize(for: image.size))?
                .jpegData(compressionQuality: 0.8)
        }
    }

    private static func loadImage(from provider: NSItemProvider) async -> UIImage? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
                continuation.resume(returning: object as? UIImage)
            }
        }
    }

    private static func thumbnailSize(for size: CGSize) -> CGSize {
        let longest = max(size.width, size.height)
        guard longest > 640 else { return size }
        let scale = 640 / longest
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Asks the analyzer which exercises are in the video. The first result
    /// goes straight onto the to-try list — the point is not having to come
    /// back to the video. Running it again only refreshes the suggestions, so
    /// exercises you removed stay removed.
    @discardableResult
    static func analyze(_ video: SavedVideo, context: ModelContext) async -> Result<[ExerciseSuggestion], Error> {
        guard VideoAnalyzer.isConfigured else { return .failure(VideoAnalyzer.Failure.notConfigured) }
        let names = ((try? context.fetch(FetchDescriptor<Exercise>())) ?? []).map(\.name)
        let link = video.url
        do {
            let result = try await VideoAnalyzer.analyze(videoURL: link, knownExercises: names)
            guard isLive(video) else { return .failure(CancellationError()) }
            let isFirstResult = video.analyzedAt == nil
            video.analysis = try? JSONEncoder().encode(result.exercises)
            video.analyzedAt = Date()
            if isFirstResult {
                result.exercises.forEach { adopt($0, from: video, context: context) }
            }
            if let caption = result.caption, !caption.isEmpty { video.caption = caption }
            if let title = result.title, !title.isEmpty, video.title.isEmpty || video.title == video.source {
                video.title = title
            }
            try? context.save()
            return .success(result.exercises)
        } catch {
            return .failure(error)
        }
    }

    static func suggestions(for video: SavedVideo) -> [ExerciseSuggestion] {
        guard let data = video.analysis else { return [] }
        return (try? JSONDecoder().decode([ExerciseSuggestion].self, from: data)) ?? []
    }

    /// Puts a suggestion on the to-try list, reusing a library exercise when
    /// the name matches and creating a custom one otherwise.
    @discardableResult
    static func adopt(_ suggestion: ExerciseSuggestion, from video: SavedVideo, context: ModelContext) -> Exercise {
        let all = (try? context.fetch(FetchDescriptor<Exercise>())) ?? []
        let key = Exercise.normalize(suggestion.resolvedName)
        let exercise: Exercise
        if let existing = all.first(where: { Exercise.normalize($0.name) == key }) {
            exercise = existing
        } else {
            exercise = Exercise(
                name: suggestion.name,
                muscle: suggestion.muscleGroup.flatMap(MuscleGroup.init(rawValue:))
                    ?? StrongImporter.guessMuscle(suggestion.name),
                equipment: suggestion.equipment.flatMap(Equipment.init(rawValue:)) ?? .other,
                isCustom: true
            )
            context.insert(exercise)
        }
        link(exercise, to: video)
        var lines: [String] = []
        if let how = suggestion.notes, !how.isEmpty { lines.append(how) }
        if let prescription = suggestion.setsReps, !prescription.isEmpty { lines.append("From the video: \(prescription)") }
        if exercise.notes.isEmpty { exercise.notes = lines.joined(separator: "\n") }
        try? context.save()
        return exercise
    }

    static func link(_ exercise: Exercise, to video: SavedVideo) {
        exercise.savedVideo = video
        exercise.videoURL = video.url
        exercise.wantToTry = true
    }
}
