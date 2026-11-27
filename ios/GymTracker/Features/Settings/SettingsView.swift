import SwiftData
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @AppStorage(SettingsKey.effort) private var effort: EffortScale = .rpe
    @AppStorage(SettingsKey.analyzerURL) private var analyzerURL = ""
    @State private var connection: ConnectionState = .unknown

    private enum ConnectionState {
        case unknown, checking, ok, failed
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Weight unit", selection: $unit) {
                        ForEach(WeightUnit.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Picker("Effort scale", selection: $effort) {
                        ForEach(EffortScale.allCases) { Text($0.title).tag($0) }
                    }
                } header: {
                    Text("Logging")
                } footer: {
                    Text("RPE rates how hard a set was out of 10; RIR counts the reps you had left. They're two views of the same thing (RIR = 10 − RPE), so you can switch any time.")
                }

                Section {
                    NavigationLink {
                        StrongImportView()
                    } label: {
                        Label("Import from Strong", systemImage: "square.and.arrow.down")
                    }
                } header: {
                    Text("Data")
                }

                Section {
                    TextField("Analyzer address", text: $analyzerURL, prompt: Text(verbatim: "http://my-mac.local:8787"))
                        .accessibilityLabel("Analyzer address") // a field with a prompt doesn't expose its title
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: analyzerURL) { connection = .unknown }
                    Button {
                        Task { await checkConnection() }
                    } label: {
                        HStack {
                            Text("Test Connection")
                            Spacer()
                            switch connection {
                            case .unknown: EmptyView()
                            case .checking: ProgressView()
                            case .ok: Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            case .failed: Label("Not reachable", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                            }
                        }
                    }
                    .disabled(analyzerURL.trimmingCharacters(in: .whitespaces).isEmpty || connection == .checking)
                } header: {
                    Text("Video analyzer")
                } footer: {
                    Text("Address of the analyzer from this project's server folder, running on your Mac. It downloads a saved video and names the exercises in it. Your phone has to be on the same Wi-Fi as the Mac.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func checkConnection() async {
        connection = .checking
        connection = await VideoAnalyzer.isReachable() ? .ok : .failed
    }
}

/// Pick a Strong CSV export, preview what's in it, import.
struct StrongImportView: View {
    @Environment(\.modelContext) private var context
    @AppStorage(SettingsKey.unit) private var appUnit: WeightUnit = .kg
    @State private var showFilePicker = false
    @State private var parsed: StrongImport?
    @State private var fileUnit: WeightUnit = .kg
    @State private var errorMessage: String?
    @State private var summary: StrongImporter.Summary?

    var body: some View {
        Form {
            Section {
                Button("Choose CSV File…", systemImage: "doc") { showFilePicker = true }
            } footer: {
                Text("In Strong: Profile → Settings → Export Strong Data. Save the file to Files (or AirDrop it to this phone), then choose it here.")
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }

            if let parsed, summary == nil {
                Section {
                    LabeledContent("Workouts", value: "\(parsed.workouts.count)")
                    LabeledContent("Exercises", value: "\(parsed.exerciseNames.count)")
                    LabeledContent("Sets", value: "\(parsed.setCount)")
                    if let first = parsed.workouts.first?.date, let last = parsed.workouts.last?.date {
                        LabeledContent("Period", value: "\(first.formatted(date: .abbreviated, time: .omitted)) – \(last.formatted(date: .abbreviated, time: .omitted))")
                    }
                    if parsed.skippedRows > 0 {
                        LabeledContent("Rows skipped", value: "\(parsed.skippedRows)")
                    }
                    if parsed.headerUnit == nil {
                        Picker("Weights in the file are in", selection: $fileUnit) {
                            ForEach(WeightUnit.allCases) { Text($0.rawValue).tag($0) }
                        }
                    }
                } header: {
                    Text("Found in the file")
                } footer: {
                    if parsed.headerUnit == nil {
                        Text("This export doesn't say which unit it uses — pick the one Strong was set to.")
                    }
                }

                Section {
                    Button("Import \(Fmt.count(parsed.workouts.count, "Workout"))") {
                        summary = StrongImporter.apply(parsed, unit: parsed.headerUnit ?? fileUnit, context: context)
                    }
                    .fontWeight(.semibold)
                    .disabled(parsed.workouts.isEmpty)
                }
            }

            if let summary {
                Section {
                    Label("Imported \(Fmt.count(summary.workouts, "workout")) and \(Fmt.count(summary.sets, "set"))",
                          systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    if summary.newExercises > 0 {
                        Text(summary.newExercises == 1
                             ? "1 exercise wasn't in the built-in list and was added as your own."
                             : "\(summary.newExercises) exercises weren't in the built-in list and were added as your own.")
                    }
                    if summary.alreadyImported > 0 {
                        Text(summary.alreadyImported == 1
                             ? "1 workout was already here and was skipped."
                             : "\(summary.alreadyImported) workouts were already here and were skipped.")
                    }
                }
            }
        }
        .navigationTitle("Import from Strong")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { fileUnit = appUnit }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.commaSeparatedText, .plainText, .data]) { result in
            load(result)
        }
    }

    private func load(_ result: Result<URL, Error>) {
        parsed = nil
        summary = nil
        errorMessage = nil
        do {
            let url = try result.get()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
                errorMessage = "Couldn't read that file as text."
                return
            }
            parsed = try StrongCSVParser.parse(text)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
