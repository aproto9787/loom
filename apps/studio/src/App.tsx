import { Background, Controls, ReactFlow, type Edge, type Node } from "reactflow";

const nodes: Node[] = [];
const edges: Edge[] = [];

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">Palette</p>
        <h1>Loom Studio</h1>
        <p className="sidebar-copy">Drag-and-drop nodes will land here in the next slice.</p>
        <div className="placeholder-card">
          <span>io.input</span>
          <span>router.code</span>
          <span>io.file</span>
          <span>agent.claude</span>
          <span>io.output</span>
        </div>
      </aside>
      <main className="canvas-shell">
        <div className="canvas-header">Loom Studio</div>
        <ReactFlow fitView nodes={nodes} edges={edges} proOptions={{ hideAttribution: true }}>
          <Background gap={20} size={1.1} color="#d9d6cf" />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}
