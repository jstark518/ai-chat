import { useState } from "react";
import { useSmartHome } from "./hooks/useSmartHome";
import { SmartHomeTab } from "./components/SmartHomeTab";
import { AgentDebugTab } from "./components/AgentDebugTab";
import { ChatTab } from "./components/ChatTab";

const TABS = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "agent", label: "Agent Debug", icon: "🤖" },
  { id: "smarthome", label: "Smart Home", icon: "🏠" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const smartHome = useSmartHome();

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800">
        <div className="px-6 pt-4 pb-0">
          <h1 className="text-2xl font-bold">AI Assistant</h1>
          <p className="text-sm text-gray-400 mt-1">Control panel & debug tools</p>
        </div>
        <nav className="px-6 flex gap-1 mt-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                activeTab === tab.id
                  ? "bg-gray-900 text-white border-t border-x border-gray-700"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-900/50"
              }`}
            >
              <span className="mr-1.5">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="p-6">
        {activeTab === "chat" && <ChatTab />}
        {activeTab === "smarthome" && (
          smartHome.loading || !smartHome.state ? (
            <p className="text-gray-400 text-lg text-center py-12">Loading smart home...</p>
          ) : (
            <SmartHomeTab {...smartHome} state={smartHome.state} />
          )
        )}
        {activeTab === "agent" && <AgentDebugTab />}
      </main>
    </div>
  );
}
