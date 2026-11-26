import Foundation
import SwiftData

enum MuscleGroup: String, CaseIterable, Identifiable, Codable {
    case chest, back, shoulders, biceps, triceps, forearms, core
    case quads, hamstrings, glutes, calves, fullBody, cardio, other

    var id: String { rawValue }
    var title: String {
        switch self {
        case .fullBody: "Full Body"
        case .glutes: "Glutes & Hips"
        default: rawValue.capitalized
        }
    }
}

enum Equipment: String, CaseIterable, Identifiable, Codable {
    case barbell, dumbbell, machine, cable, bodyweight, kettlebell, band, other

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

@Model
final class Exercise {
    var name: String
    var muscleRaw: String
    var equipmentRaw: String
    var isCustom: Bool
    var notes: String
    /// Link to the clip this exercise came from, if any.
    var videoURL: String?
    /// Saved from a video and not performed yet — surfaced when picking exercises.
    var wantToTry: Bool
    var createdAt: Date

    @Relationship(deleteRule: .nullify, inverse: \WorkoutExercise.exercise)
    var entries: [WorkoutExercise] = []
    var savedVideo: SavedVideo?

    init(name: String, muscle: MuscleGroup, equipment: Equipment, isCustom: Bool = false, notes: String = "") {
        self.name = name
        self.muscleRaw = muscle.rawValue
        self.equipmentRaw = equipment.rawValue
        self.isCustom = isCustom
        self.notes = notes
        self.wantToTry = false
        self.createdAt = Date()
    }

    var muscle: MuscleGroup {
        get { MuscleGroup(rawValue: muscleRaw) ?? .other }
        set { muscleRaw = newValue.rawValue }
    }

    var equipment: Equipment {
        get { Equipment(rawValue: equipmentRaw) ?? .other }
        set { equipmentRaw = newValue.rawValue }
    }

    var subtitle: String { "\(muscle.title) · \(equipment.title)" }

    /// Key used to recognise the same exercise across imports and AI results:
    /// "Bench Press (Barbell)" and "bench press barbell" compare equal.
    static func normalize(_ name: String) -> String {
        name.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

@Model
final class Workout {
    var name: String
    var startedAt: Date
    /// nil while the workout is in progress.
    var endedAt: Date?
    var notes: String

    @Relationship(deleteRule: .cascade, inverse: \WorkoutExercise.workout)
    var entries: [WorkoutExercise] = []

    init(name: String, startedAt: Date = Date(), endedAt: Date? = nil, notes: String = "") {
        self.name = name
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.notes = notes
    }

    var sortedEntries: [WorkoutExercise] { entries.sorted { $0.order < $1.order } }
    var duration: TimeInterval { (endedAt ?? Date()).timeIntervalSince(startedAt) }
    var doneSets: [SetEntry] { entries.flatMap(\.sets).filter(\.isDone) }

    /// Total kilograms moved, warm-ups excluded.
    var volumeKg: Double {
        doneSets.filter { !$0.isWarmup }.reduce(0) { $0 + ($1.weight ?? 0) * Double($1.reps ?? 0) }
    }
}

/// One exercise performed inside one workout.
@Model
final class WorkoutExercise {
    var order: Int
    /// Kept so history stays readable if the exercise is later deleted.
    var exerciseName: String
    var notes: String
    var workout: Workout?
    var exercise: Exercise?

    @Relationship(deleteRule: .cascade, inverse: \SetEntry.entry)
    var sets: [SetEntry] = []

    /// `workout` and `exercise` are linked by `WorkoutService.insertEntry` once
    /// the entry is in the context — see the note there before adding them here.
    init(order: Int, name: String, notes: String = "") {
        self.order = order
        self.exerciseName = name
        self.notes = notes
    }

    var sortedSets: [SetEntry] { sets.sorted { $0.order < $1.order } }
    var displayName: String { exercise?.name ?? exerciseName }
}

@Model
final class SetEntry {
    var order: Int
    /// Kilograms; nil for bodyweight.
    var weight: Double?
    var reps: Int?
    var rpe: Double?
    var isWarmup: Bool
    var isDone: Bool
    var entry: WorkoutExercise?

    init(order: Int, weight: Double? = nil, reps: Int? = nil, rpe: Double? = nil,
         isWarmup: Bool = false, isDone: Bool = false) {
        self.order = order
        self.weight = weight
        self.reps = reps
        self.rpe = rpe
        self.isWarmup = isWarmup
        self.isDone = isDone
    }

    /// Epley estimate; only meaningful for weighted sets.
    var estimatedOneRepMax: Double? {
        guard let weight, let reps, weight > 0, reps > 0 else { return nil }
        return reps == 1 ? weight : weight * (1 + Double(reps) / 30)
    }
}

extension Array where Element == SetEntry {
    /// Working sets are numbered 1, 2, 3…; warm-ups show "W" and don't count.
    var rowLabels: [String] {
        var number = 0
        return map { set in
            if set.isWarmup { return "W" }
            number += 1
            return "\(number)"
        }
    }
}

@Model
final class BodyWeight {
    var date: Date
    var kg: Double

    init(date: Date = Date(), kg: Double) {
        self.date = date
        self.kg = kg
    }
}

/// A workout clip saved from Instagram, TikTok, YouTube…
@Model
final class SavedVideo {
    var url: String
    var title: String
    var caption: String
    @Attribute(.externalStorage) var thumbnail: Data?
    var addedAt: Date
    var analyzedAt: Date?
    /// Raw analyzer suggestions, kept so reopening the video doesn't cost another AI call.
    var analysis: Data?

    @Relationship(deleteRule: .nullify, inverse: \Exercise.savedVideo)
    var exercises: [Exercise] = []

    init(url: String, title: String = "", caption: String = "") {
        self.url = url
        self.title = title
        self.caption = caption
        self.addedAt = Date()
    }

    var source: String {
        let host = URL(string: url)?.host?.lowercased() ?? ""
        if host.contains("instagram") { return "Instagram" }
        if host.contains("tiktok") { return "TikTok" }
        if host.contains("youtu") { return "YouTube" }
        if host.contains("facebook") || host.contains("fb.watch") { return "Facebook" }
        return host.replacingOccurrences(of: "www.", with: "")
    }

    var displayTitle: String { title.isEmpty ? "\(source) video" : title }
}
