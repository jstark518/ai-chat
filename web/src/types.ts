export interface Light {
  id: string;
  name: string;
  room: string;
  on: boolean;
  brightness: number;
  color: string;
  source: "mock" | "govee" | "kasa";
  goveeSku?: string;
  goveeDevice?: string;
}

export interface Thermostat {
  id: string;
  name: string;
  currentTemp: number;
  targetTemp: number;
  mode: "heat" | "cool" | "auto" | "off";
  humidity: number;
}

export interface Lock {
  id: string;
  name: string;
  locked: boolean;
  lastChanged: string;
}

export interface Sensor {
  id: string;
  name: string;
  room: string;
  type: "motion" | "door" | "window" | "temperature" | "humidity";
  state: string;
  lastTriggered: string;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  actions: string[];
}

export interface SmartHomeState {
  lights: Light[];
  thermostats: Thermostat[];
  locks: Lock[];
  sensors: Sensor[];
  scenes: Scene[];
}
