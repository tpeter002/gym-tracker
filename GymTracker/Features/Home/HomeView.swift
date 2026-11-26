import SwiftData
import SwiftUI

/// Landing tab: start or resume a workout, see what's waiting from saved
/// videos, and repeat a recent session.
struct HomeView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppRouter.self) private var router
    @Query(filter: #Predicate<Workout> { $0.endedAt == nil })
    private var active: [Workout]
    @Query(filter: #Predicate<Workout> { $0.endedAt != nil }, sort: \Workout.startedAt, order: .reverse)
    private var finished: [Workout]
    @Query(filter: #Predicate<Exercise> { $0.wantToTry == true }, sort: \Exercise.createdAt, order: .reverse)
    private var toTry: [Exercise]
    @Query(sort: \SavedVideo.addedAt, order: .reverse)
    private var videos: [SavedVideo]
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let workout = active.first {
                        resumeCard(workout)
                    } else {
                        startButton
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

                Section {
                    NavigationLink {
                        SavedVideosView()
                    } label: {
                        Label {
                            HStack {
                                Text("Saved Videos")
                                Spacer()
                                Text("\(videos.count)")
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "play.rectangle.on.rectangle.fill")
                        }
                    }
                    ForEach(toTry.prefix(5)) { exercise in
                        NavigationLink {
                            ExerciseDetailView(exercise: exercise)
                        } label: {
                            ExerciseRowLabel(exercise: exercise)
                        }
                    }
                } header: {
                    Text("To try")
                } footer: {
                    if videos.isEmpty {
                        Text("Share a workout reel, short or TikTok to Gym Tracker and its exercises show up here.")
                    } else if toTry.count > 5 {
                        Text("\(toTry.count - 5) more in the exercise picker.")
                    }
                }

                if !finished.isEmpty {
                    Section("Recent") {
                        ForEach(finished.prefix(5)) { workout in
                            NavigationLink {
                                WorkoutDetailView(workout: workout)
                            } label: {
                                WorkoutSummaryLabel(workout: workout)
                            }
                            .swipeActions(edge: .leading) {
                                Button {
                                    router.start(.repeating(workout), in: context)
                                } label: {
                                    Label("Repeat", systemImage: "arrow.clockwise")
                                }
                                .tint(.accentColor)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Workout")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
    }

    private var startButton: some View {
        Button {
            router.start(.empty, in: context)
        } label: {
            Label("Start Empty Workout", systemImage: "plus")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    private func resumeCard(_ workout: Workout) -> some View {
        Button {
            router.showActiveWorkout = true
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "figure.strengthtraining.traditional")
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(workout.name)
                        .font(.headline)
                    HStack(spacing: 4) {
                        Text("In progress ·")
                        ElapsedTimeView(since: workout.startedAt)
                    }
                    .font(.subheadline)
                    .opacity(0.9)
                }
                Spacer()
                Text("Resume")
                    .font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.up")
                    .font(.subheadline.weight(.semibold))
            }
            .padding(16)
            .foregroundStyle(.white)
            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
