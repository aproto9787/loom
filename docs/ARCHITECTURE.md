# Architecture

Phase 1 keeps the execution path intentionally narrow: `io.input -> agent.claude -> io.output`.
The monorepo is split into shared schemas (`packages/core`), runtime adapters (`packages/adapters`), node metadata (`packages/nodes`), the Fastify API (`apps/server`), and the React Flow studio shell (`apps/studio`).
