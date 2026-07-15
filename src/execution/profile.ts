export type CommandExecutionProfile = "host" | "container" | "sandbox";

export type CommandExecutionProfileInfo = {
  profile: CommandExecutionProfile;
  isolation: string;
  supported: boolean;
  reason?: string;
};

export function resolveCommandExecutionProfile(profile: CommandExecutionProfile | undefined): CommandExecutionProfileInfo {
  const requested = profile ?? "host";
  if (requested === "host") {
    return {
      profile: "host",
      isolation: "local host process",
      supported: true
    };
  }
  return {
    profile: requested,
    isolation: requested === "container" ? "container execution plane" : "sandbox execution plane",
    supported: false,
    reason: `${requested} execution is not configured yet. Use task worktree mode for git isolation, or run this command with executionProfile: "host".`
  };
}
