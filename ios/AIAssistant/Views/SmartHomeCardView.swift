import SwiftUI

struct SmartHomeCardView: View {
    let message: Message
    var onDeviceControl: ((String, String, [String: Any]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title
            HStack {
                Image(systemName: "house.fill")
                    .foregroundStyle(.blue)
                Text(message.content)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color(.label))
            }

            if let devices = message.devices {
                let lights = devices.filter { $0.deviceType == .light }
                let locks = devices.filter { $0.deviceType == .lock }
                let thermostats = devices.filter { $0.deviceType == .thermostat }
                let sensors = devices.filter { $0.deviceType == .sensor }

                if !lights.isEmpty {
                    LightsSection(lights: lights, onControl: onDeviceControl)
                }
                if !thermostats.isEmpty {
                    ThermostatSection(thermostat: thermostats[0], onControl: onDeviceControl)
                }
                if !locks.isEmpty {
                    LocksSection(locks: locks, onControl: onDeviceControl)
                }
                if !sensors.isEmpty {
                    SensorsSection(sensors: sensors)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Lights Section (with inline slider + color dot)

private struct LightsSection: View {
    let lights: [DeviceInfo]
    var onControl: ((String, String, [String: Any]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Lights")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(lights) { light in
                LightRow(light: light, onControl: onControl)
            }
        }
    }
}

private struct LightRow: View {
    let light: DeviceInfo
    var onControl: ((String, String, [String: Any]) -> Void)?
    @State private var localBrightness: Double = 50
    @State private var hasInitialized = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                // Color indicator dot
                Circle()
                    .fill(lightColor)
                    .frame(width: 10, height: 10)
                    .overlay(
                        Circle()
                            .stroke(.gray.opacity(0.3), lineWidth: 0.5)
                    )

                VStack(alignment: .leading, spacing: 1) {
                    Text(light.name)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(Color(.label))
                    if let room = light.room {
                        Text(room)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                // Toggle button
                Button {
                    HapticManager.light()
                    onControl?(light.id, "toggle", ["on": !(light.on ?? false)])
                } label: {
                    Image(systemName: light.on == true ? "lightbulb.fill" : "lightbulb")
                        .foregroundStyle(light.on == true ? .yellow : .gray)
                        .font(.body)
                }
            }

            // Inline brightness slider (only when on)
            if light.on == true {
                HStack(spacing: 6) {
                    Image(systemName: "sun.min")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Slider(value: $localBrightness, in: 1...100, step: 1) { editing in
                        if !editing {
                            HapticManager.selection()
                            onControl?(light.id, "brightness", ["brightness": Int(localBrightness)])
                        }
                    }
                    .tint(.yellow)
                    Text("\(Int(localBrightness))%")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, alignment: .trailing)
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color(.systemGray5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onAppear {
            if !hasInitialized {
                localBrightness = Double(light.brightness ?? 50)
                hasInitialized = true
            }
        }
        .onChange(of: light.brightness) {
            if let b = light.brightness { localBrightness = Double(b) }
        }
    }

    private var lightColor: Color {
        guard light.on == true else { return .gray.opacity(0.5) }
        if let hex = light.color, hex.hasPrefix("#"), hex.count == 7 {
            let r = Double(Int(hex.dropFirst(1).prefix(2), radix: 16) ?? 255) / 255
            let g = Double(Int(hex.dropFirst(3).prefix(2), radix: 16) ?? 255) / 255
            let b = Double(Int(hex.dropFirst(5).prefix(2), radix: 16) ?? 255) / 255
            return Color(red: r, green: g, blue: b)
        }
        return .yellow
    }
}

// MARK: - Thermostat Section (with gauge)

private struct ThermostatSection: View {
    let thermostat: DeviceInfo
    var onControl: ((String, String, [String: Any]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Thermostat")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(spacing: 8) {
                HStack(alignment: .center, spacing: 12) {
                    // Gauge showing current vs target
                    ZStack {
                        Circle()
                            .stroke(Color(.systemGray4), lineWidth: 4)
                            .frame(width: 52, height: 52)
                        Circle()
                            .trim(from: 0, to: gaugeProgress)
                            .stroke(modeColor, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .frame(width: 52, height: 52)
                            .rotationEffect(.degrees(-90))
                        VStack(spacing: 0) {
                            if let current = thermostat.currentTemp {
                                Text("\(Int(current))°")
                                    .font(.subheadline)
                                    .fontWeight(.bold)
                                    .foregroundStyle(Color(.label))
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text("Target")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if let target = thermostat.targetTemp {
                                Text("\(Int(target))°")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(Color(.label))
                            }
                        }
                        if let mode = thermostat.mode {
                            Text(mode.capitalized)
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(modeColor.opacity(0.2))
                                .foregroundStyle(modeColor)
                                .clipShape(Capsule())
                        }
                        if let humidity = thermostat.humidity {
                            Text("💧 \(humidity)%")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    // Up/down buttons
                    VStack(spacing: 4) {
                        Button {
                            HapticManager.light()
                            if let t = thermostat.targetTemp {
                                onControl?(thermostat.id, "thermostat", ["targetTemp": t + 1])
                            }
                        } label: {
                            Image(systemName: "chevron.up")
                                .font(.caption)
                                .frame(width: 24, height: 20)
                                .background(Color(.systemGray4))
                                .foregroundStyle(Color(.label))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        Button {
                            HapticManager.light()
                            if let t = thermostat.targetTemp {
                                onControl?(thermostat.id, "thermostat", ["targetTemp": t - 1])
                            }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.caption)
                                .frame(width: 24, height: 20)
                                .background(Color(.systemGray4))
                                .foregroundStyle(Color(.label))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                }
            }
            .padding(8)
            .background(Color(.systemGray5))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var gaugeProgress: CGFloat {
        guard let current = thermostat.currentTemp else { return 0 }
        // Map 50-90°F to 0-1 gauge fill
        return CGFloat(max(0, min(1, (current - 50) / 40)))
    }

    private var modeColor: Color {
        switch thermostat.mode {
        case "heat": return .orange
        case "cool": return .blue
        case "auto": return .green
        default: return .gray
        }
    }
}

// MARK: - Locks Section

private struct LocksSection: View {
    let locks: [DeviceInfo]
    var onControl: ((String, String, [String: Any]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Locks")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(locks) { lock in
                HStack {
                    Image(systemName: lock.locked == true ? "lock.fill" : "lock.open.fill")
                        .foregroundStyle(lock.locked == true ? .green : .red)

                    Text(lock.name)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(Color(.label))

                    Spacer()

                    Button {
                        HapticManager.medium()
                        onControl?(lock.id, "lock", ["locked": !(lock.locked ?? false)])
                    } label: {
                        Text(lock.locked == true ? "Locked" : "Unlocked")
                            .font(.caption2)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(lock.locked == true ? Color.green.opacity(0.2) : Color.red.opacity(0.2))
                            .foregroundStyle(lock.locked == true ? .green : .red)
                            .clipShape(Capsule())
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 8)
                .background(Color(.systemGray5))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// MARK: - Sensors Section

private struct SensorsSection: View {
    let sensors: [DeviceInfo]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Sensors")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(sensors) { sensor in
                HStack {
                    Image(systemName: sensorIcon(sensor.sensorType))
                        .foregroundStyle(.blue)

                    Text(sensor.name)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(Color(.label))

                    Spacer()

                    Text(sensor.state ?? "unknown")
                        .font(.caption2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(sensorStateColor(sensor.state).opacity(0.2))
                        .foregroundStyle(sensorStateColor(sensor.state))
                        .clipShape(Capsule())
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 8)
                .background(Color(.systemGray5))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func sensorIcon(_ type: String?) -> String {
        switch type {
        case "motion": return "eye"
        case "door": return "door.left.hand.open"
        case "window": return "window.vertical.open"
        default: return "sensor"
        }
    }

    private func sensorStateColor(_ state: String?) -> Color {
        switch state {
        case "clear", "closed": return .green
        case "detected", "open": return .orange
        default: return .gray
        }
    }
}

#Preview {
    VStack {
        SmartHomeCardView(
            message: Message(
                role: .assistant,
                content: "Living Room",
                type: .smartHomeCard,
                devices: [
                    DeviceInfo(id: "light-1", name: "Overhead Light", deviceType: .light, room: "Living Room", on: true, brightness: 80, color: "#FFFFFF"),
                    DeviceInfo(id: "light-2", name: "Floor Lamp", deviceType: .light, room: "Living Room", on: true, brightness: 50, color: "#FFD700"),
                    DeviceInfo(id: "light-3", name: "Off Light", deviceType: .light, room: "Living Room", on: false),
                    DeviceInfo(id: "lock-1", name: "Front Door", deviceType: .lock, locked: true),
                    DeviceInfo(id: "therm-1", name: "Thermostat", deviceType: .thermostat, currentTemp: 72, targetTemp: 70, mode: "cool", humidity: 45),
                    DeviceInfo(id: "sensor-1", name: "Motion", deviceType: .sensor, sensorType: "motion", state: "clear"),
                ]
            )
        )
    }
    .padding()
}
