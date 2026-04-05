import SwiftUI
import LinkPresentation

struct LinkPreviewView: View {
    let url: URL
    @State private var metadata: LPLinkMetadata?
    @State private var isLoading = true
    @State private var title: String?
    @State private var iconImage: UIImage?

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 10) {
                if let iconImage {
                    Image(uiImage: iconImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 36, height: 36)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    Image(systemName: "link")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .background(Color(.systemGray5))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title ?? url.host ?? url.absoluteString)
                        .font(.caption)
                        .fontWeight(.medium)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(.primary)
                    Text(url.host ?? "")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .task {
            await fetchMetadata()
        }
    }

    private func fetchMetadata() async {
        let provider = LPMetadataProvider()
        do {
            let meta = try await provider.startFetchingMetadata(for: url)
            await MainActor.run {
                self.metadata = meta
                self.title = meta.title
            }

            // Fetch icon
            if let iconProvider = meta.iconProvider {
                iconProvider.loadObject(ofClass: UIImage.self) { image, _ in
                    if let image = image as? UIImage {
                        DispatchQueue.main.async {
                            self.iconImage = image
                        }
                    }
                }
            }
            isLoading = false
        } catch {
            isLoading = false
        }
    }
}

/// Extracts URLs from text using NSDataDetector
func extractURLs(from text: String) -> [URL] {
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
        return []
    }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return detector.matches(in: text, options: [], range: range)
        .compactMap { $0.url }
}
