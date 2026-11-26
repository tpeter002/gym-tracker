import SwiftData
import SwiftUI

/// One saved clip: watch it, let the analyzer name its exercises, and put
/// them on the to-try list.
struct VideoDetailView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage(SettingsKey.analyzerURL) private var analyzerURL = ""
    let video: SavedVideo

    @State private var isAnalyzing = false
    @State private var errorMessage: String?
    @State private var showPicker = false

    /// Suggestions the user hasn't added yet.
    private var pending: [ExerciseSuggestion] {
        let added = Set(video.exercises.map { Exercise.normalize($0.name) })
        return VideoInbox.suggestions(for: video).filter { suggestion in
            !added.contains(Exercise.normalize(suggestion.resolvedName))
                && !added.contains(Exercise.normalize(suggestion.name))
        }
    }

    var body: some View {
        let pending = self.pending

        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    VideoThumbnail(data: video.thumbnail)
                        .frame(maxWidth: .infinity)
                        .frame(height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    Text(video.displayTitle)
                        .font(.headline)
                    if !video.caption.isEmpty {
                        Text(video.caption)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(6)
                    }
                }
                .padding(.vertical, 4)
                if let url = URL(string: video.url) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open in \(video.source)", systemImage: "play.fill")
                    }
                }
            }

            if !video.exercises.isEmpty {
                Section("On your list") {
                    ForEach(video.exercises.sorted { $0.name < $1.name }) { exercise in
                        NavigationLink {
                            ExerciseDetailView(exercise: exercise)
                        } label: {
                            ExerciseRowLabel(exercise: exercise)
                        }
                        .swipeActions {
                            Button("Remove", role: .destructive) { unlink(exercise) }
                        }
                    }
                }
            }

            if !pending.isEmpty {
                Section {
                    ForEach(pending) { suggestion in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(suggestion.resolvedName)
                                if let notes = suggestion.notes, !notes.isEmpty {
                                    Text(notes)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if let prescription = suggestion.setsReps, !prescription.isEmpty {
                                    Text(prescription)
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            Spacer()
                            Button {
                                VideoInbox.adopt(suggestion, from: video, context: context)
                            } label: {
                                Image(systemName: "plus.circle.fill")
                                    .font(.title2)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Add \(suggestion.resolvedName)")
                        }
                    }
                    Button("Add All \(pending.count)", systemImage: "plus") {
                        pending.forEach { VideoInbox.adopt($0, from: video, context: context) }
                    }
                    .fontWeight(.semibold)
                } header: {
                    Text("Found in this video")
                } footer: {
                    Text("Identified by AI from the video — check the names before you rely on them.")
                }
            }

            Section {
                Button {
                    Task { await analyze() }
                } label: {
                    HStack {
                        Label(video.analyzedAt == nil ? "Identify Exercises" : "Identify Again", systemImage: "sparkles")
                        if isAnalyzing {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isAnalyzing || analyzerURL.trimmingCharacters(in: .whitespaces).isEmpty)

                Button("Add Exercise Manually", systemImage: "hand.tap") { showPicker = true }
            } footer: {
                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                } else if analyzerURL.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Automatic identification needs the analyzer running on your Mac — set its address in Settings.")
                } else if isAnalyzing {
                    Text("Downloading and watching the video. This can take up to a minute.")
                } else if video.analyzedAt != nil, pending.isEmpty, video.exercises.isEmpty {
                    Text("The analyzer didn't recognise any exercises in this video.")
                }
            }
        }
        .navigationTitle("Saved Video")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) {
                    dismiss()
                    afterDismissal {
                        context.delete(video)
                        try? context.save()
                    }
                } label: {
                    Image(systemName: "trash")
                }
                .accessibilityLabel("Delete video")
            }
        }
        .sheet(isPresented: $showPicker) {
            ExercisePickerView { chosen in
                chosen.forEach { VideoInbox.link($0, to: video) }
                try? context.save()
            }
        }
        .task {
            if video.thumbnail == nil || video.title.isEmpty {
                await VideoInbox.fetchPreview(for: video)
            }
        }
    }

    private func analyze() async {
        isAnalyzing = true
        errorMessage = nil
        if case .failure(let error) = await VideoInbox.analyze(video, context: context) {
            errorMessage = error.localizedDescription
        }
        isAnalyzing = false
    }

    private func unlink(_ exercise: Exercise) {
        exercise.savedVideo = nil
        exercise.wantToTry = false
        if exercise.videoURL == video.url { exercise.videoURL = nil }
        try? context.save()
    }
}
