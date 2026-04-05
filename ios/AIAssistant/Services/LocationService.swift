import CoreLocation

@Observable
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    var currentLocation: CLLocation?
    var authorizationStatus: CLAuthorizationStatus = .notDetermined
    var lastUploadedAt: Date?

    private let minUploadInterval: TimeInterval = 5 * 60 // 5 minutes
    private var oneShotHandlers: [(CLLocation) -> Void] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 50 // only update when moved 50+ meters
    }

    func requestPermission() {
        manager.requestWhenInUseAuthorization()
    }

    func requestLocation() {
        manager.requestLocation()
    }

    /// Fetch a single fresh location, calling the completion with the result (or the current cached one if available immediately).
    func fetchOnce(completion: @escaping (CLLocation?) -> Void) {
        // If we have a recent location (< 30s old), use it immediately
        if let current = currentLocation, Date().timeIntervalSince(current.timestamp) < 30 {
            completion(current)
            return
        }

        // Otherwise queue a handler and request fresh
        oneShotHandlers.append { loc in completion(loc) }
        manager.requestLocation()

        // Timeout after 8 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, !self.oneShotHandlers.isEmpty else { return }
            self.oneShotHandlers.removeAll()
            completion(self.currentLocation) // fall back to last known (may be nil)
        }
    }

    func startUpdating() {
        manager.startUpdatingLocation()
    }

    func stopUpdating() {
        manager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        currentLocation = loc
        uploadIfNeeded(loc)

        // Fire any pending one-shot handlers
        let handlers = oneShotHandlers
        oneShotHandlers.removeAll()
        for h in handlers { h(loc) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("Location error: \(error)")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways {
            manager.requestLocation()
            manager.startUpdatingLocation()
        }
    }

    private func uploadIfNeeded(_ location: CLLocation) {
        // Throttle uploads — only send if we haven't uploaded recently
        if let last = lastUploadedAt, Date().timeIntervalSince(last) < minUploadInterval {
            return
        }
        lastUploadedAt = Date()

        Task {
            do {
                try await APIService.shared.sendLocation(
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude
                )
                print("Location uploaded: \(location.coordinate.latitude), \(location.coordinate.longitude)")
            } catch {
                print("Failed to upload location: \(error)")
            }
        }
    }
}
