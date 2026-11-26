import SwiftData
import SwiftUI

/// Clips shared from Instagram / TikTok / YouTube, waiting to be turned into exercises.
struct SavedVideosView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \SavedVideo.addedAt, order: .reverse) private var videos: [SavedVideo]
    @State private var showAdd = false

    var body: some View {
        Group {
            if videos.isEmpty {
                ContentUnavailableView {
                    Label("No Saved Videos", systemImage: "play.rectangle.on.rectangle")
                } description: {
                    Text("In Instagram, TikTok or YouTube tap Share and pick Gym Tracker — or paste a link here.")
                } actions: {
                    Button("Add Link") { showAdd = true }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    ForEach(videos) { video in
                        NavigationLink {
                            VideoDetailView(video: video)
                        } label: {
                            VideoRow(video: video)
                        }
                    }
                    .onDelete { offsets in
                        offsets.map { videos[$0] }.forEach { context.delete($0) }
                        afterDismissal { try? context.save() }
                    }
                }
            }
        }
        .navigationTitle("Saved Videos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAdd = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add link")
            }
        }
        .sheet(isPresented: $showAdd) {
            AddVideoLinkView()
                .presentationDetents([.medium])
        }
    }
}

private struct VideoRow: View {
    let video: SavedVideo

    var body: some View {
        HStack(spacing: 12) {
            VideoThumbnail(data: video.thumbnail)
                .frame(width: 54, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(video.displayTitle)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                Text("\(video.source) · \(video.addedAt.formatted(date: .abbreviated, time: .omitted))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(status)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(video.exercises.isEmpty ? Color.secondary : Color.accentColor)
            }
        }
        .padding(.vertical, 2)
    }

    private var status: String {
        if !video.exercises.isEmpty {
            return "\(video.exercises.count) exercise\(video.exercises.count == 1 ? "" : "s") added"
        }
        let found = VideoInbox.suggestions(for: video).count
        if found > 0 { return "\(found) exercise\(found == 1 ? "" : "s") found — review" }
        return video.analyzedAt == nil ? "Not identified yet" : "No exercises found"
    }
}

struct VideoThumbnail: View {
    let data: Data?

    var body: some View {
        if let data, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Color(.tertiarySystemFill)
                Image(systemName: "play.fill")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct AddVideoLinkView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var showInvalid = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Video link", text: $link, prompt: Text(verbatim: "https://…"), axis: .vertical)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Video link") // a field with a prompt doesn't expose its title
                    Button("Paste from Clipboard", systemImage: "doc.on.clipboard") {
                        link = UIPasteboard.general.string ?? link
                    }
                } footer: {
                    if showInvalid {
                        Text("That doesn't contain a link.")
                            .foregroundStyle(.red)
                    } else {
                        Text("Reels, Shorts and TikToks all work. Sharing straight from those apps is quicker.")
                    }
                }
            }
            .navigationTitle("Add Video Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if VideoInbox.add(link, context: context) != nil {
                            dismiss()
                        } else {
                            showInvalid = true
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
