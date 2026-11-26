import Charts
import SwiftData
import SwiftUI

/// Body-weight log with a trend chart.
struct BodyWeightView: View {
    @Environment(\.modelContext) private var context
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    @Query(sort: \BodyWeight.date, order: .reverse) private var entries: [BodyWeight]
    @State private var showLog = false
    @State private var range: ChartRange = .threeMonths

    enum ChartRange: String, CaseIterable, Identifiable {
        case month = "1M", threeMonths = "3M", year = "1Y", all = "All"

        var id: String { rawValue }
        var start: Date? {
            let calendar = Calendar.current
            switch self {
            case .month: return calendar.date(byAdding: .month, value: -1, to: Date())
            case .threeMonths: return calendar.date(byAdding: .month, value: -3, to: Date())
            case .year: return calendar.date(byAdding: .year, value: -1, to: Date())
            case .all: return nil
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if entries.isEmpty {
                    ContentUnavailableView {
                        Label("No Weigh-ins Yet", systemImage: "scalemass")
                    } description: {
                        Text("Log your body weight to see how it trends.")
                    } actions: {
                        Button("Log Weight") { showLog = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        Section {
                            summary
                            chart
                        }
                        Section("Entries") {
                            ForEach(entries) { entry in
                                HStack {
                                    Text(entry.date.formatted(date: .abbreviated, time: .omitted))
                                    Spacer()
                                    Text(unit.text(kg: entry.kg))
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                            }
                            .onDelete { offsets in
                                offsets.map { entries[$0] }.forEach { context.delete($0) }
                                afterDismissal { try? context.save() }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Body Weight")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showLog = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Log weight")
                }
            }
            .sheet(isPresented: $showLog) {
                LogWeightView(lastKg: entries.first?.kg)
                    .presentationDetents([.medium])
            }
        }
    }

    private var visible: [BodyWeight] {
        guard let start = range.start else { return entries }
        return entries.filter { $0.date >= start }
    }

    @ViewBuilder
    private var summary: some View {
        if let latest = entries.first {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(unit.text(kg: latest.kg))
                        .font(.system(.largeTitle, design: .rounded).weight(.bold))
                        .monospacedDigit()
                    Text(latest.date.formatted(date: .abbreviated, time: .omitted))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                // Change across the visible range; oldest visible entry is last.
                if let oldest = visible.last, visible.count > 1 {
                    let delta = unit.fromKg(latest.kg) - unit.fromKg(oldest.kg)
                    Label("\(delta > 0 ? "+" : "")\(Fmt.number(delta, maxDecimals: 1)) \(unit.rawValue)",
                          systemImage: delta > 0 ? "arrow.up.right" : (delta < 0 ? "arrow.down.right" : "arrow.right"))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var chart: some View {
        VStack(spacing: 12) {
            Picker("Range", selection: $range) {
                ForEach(ChartRange.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            if visible.count > 1 {
                Chart(visible) { entry in
                    LineMark(x: .value("Date", entry.date), y: .value("Weight", unit.fromKg(entry.kg)))
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("Date", entry.date), y: .value("Weight", unit.fromKg(entry.kg)))
                        .symbolSize(24)
                }
                .chartYScale(domain: .automatic(includesZero: false))
                .frame(height: 180)
            } else {
                Text("Not enough weigh-ins in this range to draw a trend.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct LogWeightView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.unit) private var unit: WeightUnit = .kg
    let lastKg: Double?
    @State private var value: Double?
    @State private var date = Date()
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                HStack {
                    Text("Weight")
                    Spacer()
                    DecimalField(value: $value, placeholder: lastKg.map { Fmt.number(unit.fromKg($0), maxDecimals: 1) } ?? "0")
                        .focused($focused)
                        .font(.title3.weight(.semibold))
                        .frame(width: 110)
                        .accessibilityLabel("Body weight")
                    Text(unit.rawValue)
                        .foregroundStyle(.secondary)
                }
                DatePicker("Date", selection: $date, in: ...Date(), displayedComponents: .date)
            }
            .navigationTitle("Log Weight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let value, value > 0 else { return }
                        context.insert(BodyWeight(date: date, kg: unit.toKg(value)))
                        try? context.save()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled((value ?? 0) <= 0)
                }
            }
            .onAppear { focused = true }
        }
    }
}
