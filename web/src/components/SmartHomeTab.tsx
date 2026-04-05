import type { SmartHomeState } from "../types";
import { LightsPanel } from "./LightsPanel";
import { ThermostatPanel } from "./ThermostatPanel";
import { LocksPanel } from "./LocksPanel";
import { SensorsPanel } from "./SensorsPanel";
import { ScenesPanel } from "./ScenesPanel";
import { GoveePanel } from "./GoveePanel";
import { KasaPanel } from "./KasaPanel";
import { SettingsPanel } from "./SettingsPanel";

interface Props {
  state: SmartHomeState;
  updateLight: (id: string, data: { on?: boolean; brightness?: number; color?: string }) => Promise<void>;
  updateThermostat: (data: { targetTemp?: number; mode?: string }) => Promise<void>;
  updateLock: (id: string, locked: boolean) => Promise<void>;
  triggerSensor: (id: string) => Promise<void>;
  activateScene: (id: string) => Promise<void>;
  setDeviceRoom: (id: string, room: string) => Promise<void>;
  deleteDevice: (id: string) => Promise<void>;
}

export function SmartHomeTab({
  state,
  updateLight,
  updateThermostat,
  updateLock,
  triggerSensor,
  activateScene,
  setDeviceRoom,
  deleteDevice,
}: Props) {
  const thermostat = state.thermostats[0];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {state.lights.length > 0 && (
        <div className="lg:col-span-2">
          <LightsPanel lights={state.lights} updateLight={updateLight} setDeviceRoom={setDeviceRoom} deleteDevice={deleteDevice} />
        </div>
      )}
      {thermostat && (
        <ThermostatPanel thermostat={thermostat} updateThermostat={updateThermostat} />
      )}
      {state.locks.length > 0 && <LocksPanel locks={state.locks} updateLock={updateLock} />}
      {state.sensors.length > 0 && <SensorsPanel sensors={state.sensors} triggerSensor={triggerSensor} />}
      {state.scenes.length > 0 && <ScenesPanel scenes={state.scenes} activateScene={activateScene} />}
      <div className="lg:col-span-2">
        <GoveePanel />
      </div>
      <div className="lg:col-span-2">
        <KasaPanel />
      </div>
      <div className="lg:col-span-2">
        <SettingsPanel />
      </div>
    </div>
  );
}
