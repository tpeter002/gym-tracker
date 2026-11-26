import Foundation

/// Keys for the handful of preferences kept in UserDefaults.
enum SettingsKey {
    static let unit = "weightUnit"
    static let effort = "effortScale"
    static let analyzerURL = "analyzerURL"
}

/// Weights are always stored in kilograms; this only affects display and entry.
enum WeightUnit: String, CaseIterable, Identifiable {
    case kg, lb

    var id: String { rawValue }
    private static let lbPerKg = 2.2046226218

    func fromKg(_ kg: Double) -> Double { self == .kg ? kg : kg * Self.lbPerKg }
    func toKg(_ value: Double) -> Double { self == .kg ? value : value / Self.lbPerKg }
    func text(kg: Double) -> String { "\(Fmt.number(fromKg(kg))) \(rawValue)" }
}

/// Effort is stored as RPE. RIR is the same information read from the other
/// end (RIR = 10 − RPE), so switching scales never loses data.
enum EffortScale: String, CaseIterable, Identifiable {
    case rpe, rir

    var id: String { rawValue }
    var title: String { self == .rpe ? "RPE" : "RIR" }

    /// Values offered in the picker, expressed in this scale.
    var choices: [Double] {
        self == .rpe ? [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6] : [0, 1, 2, 3, 4, 5]
    }

    func value(fromRPE rpe: Double) -> Double { self == .rpe ? rpe : max(0, 10 - rpe) }
    func rpe(from value: Double) -> Double { self == .rpe ? value : 10 - value }
    func text(rpe: Double) -> String { Fmt.number(value(fromRPE: rpe), maxDecimals: 1) }
    func label(rpe: Double) -> String {
        self == .rpe ? "RPE \(text(rpe: rpe))" : "\(text(rpe: rpe)) RIR"
    }
}

enum Fmt {
    /// Locale-aware number without trailing zeros: 80, 82.5, 61.25.
    static func number(_ value: Double, maxDecimals: Int = 2) -> String {
        value.formatted(.number.precision(.fractionLength(0...maxDecimals)).grouping(.never))
    }

    /// Accepts both "82.5" and "82,5" — the decimal pad follows the region setting.
    static func parseDecimal(_ text: String) -> Double? {
        let cleaned = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard !cleaned.isEmpty, let value = Double(cleaned), value.isFinite, value >= 0 else { return nil }
        return value
    }

    /// "1 workout" / "3 workouts".
    static func count(_ number: Int, _ noun: String) -> String {
        "\(number) \(noun)\(number == 1 ? "" : "s")"
    }

    /// "1h 05m" / "45m" for finished workouts.
    static func duration(_ interval: TimeInterval) -> String {
        let minutes = max(0, Int(interval.rounded())) / 60
        if minutes >= 60 {
            return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m"
        }
        return "\(minutes)m"
    }

    /// "1:05:32" / "05:32" for the running timer.
    static func clock(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}
