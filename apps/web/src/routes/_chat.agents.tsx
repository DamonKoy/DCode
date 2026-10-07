import { createFileRoute } from "@tanstack/react-router";

import { GlobalAgentsBoardPage } from "../components/agents/GlobalAgentsBoardPage";

export const Route = createFileRoute("/_chat/agents")({
  component: GlobalAgentsBoardPage,
});
