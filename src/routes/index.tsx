import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@/components/terminal/terminal";

export const Route = createFileRoute("/")({ component: Terminal });
