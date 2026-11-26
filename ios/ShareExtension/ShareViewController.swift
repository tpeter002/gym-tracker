import UIKit
import UniformTypeIdentifiers

/// Receives a link from the system share sheet (Instagram, TikTok, YouTube…),
/// drops it into the shared inbox and dismisses. The app picks it up later.
final class ShareViewController: UIViewController {
    private let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let icon = UIImageView()
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.2)

        card.layer.cornerRadius = 22
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 40, weight: .semibold)
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [icon, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 220),
            stack.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -16),
        ])
        show(symbol: "arrow.down.circle", text: "Saving…", tint: .secondaryLabel)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { @MainActor in
            let saved: Bool
            if let url = await extractURL() {
                saved = SharedInbox.append(url)
            } else {
                saved = false
            }
            if saved {
                show(symbol: "checkmark.circle.fill", text: "Saved to Gym Tracker", tint: .systemGreen)
            } else {
                show(symbol: "exclamationmark.triangle.fill", text: "Couldn't find a link to save", tint: .systemOrange)
            }
            try? await Task.sleep(nanoseconds: saved ? 900_000_000 : 1_800_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func show(symbol: String, text: String, tint: UIColor) {
        icon.image = UIImage(systemName: symbol)
        icon.tintColor = tint
        label.text = text
    }

    private func extractURL() async -> URL? {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
            if let url = item as? URL, url.scheme?.lowercased().hasPrefix("http") == true {
                return url
            }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
            if let text = item as? String, let url = SharedInbox.firstURL(in: text) {
                return url
            }
        }
        for item in items {
            if let text = item.attributedContentText?.string, let url = SharedInbox.firstURL(in: text) {
                return url
            }
        }
        return nil
    }
}
