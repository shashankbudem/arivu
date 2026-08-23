export function capabilityLabel(capability: AgentTaskRunCapability) {
  switch (capability) {
    case "read_repo":
      return "Read";
    case "write_workspace":
      return "Write";
    case "run_command":
      return "Command";
    case "network_fetch":
      return "Network";
    case "browser_control":
      return "Browser";
    case "mcp_call":
      return "MCP";
    case "skill_context":
      return "Skill";
    case "local_context":
      return "Local context";
    default:
      return "Unknown";
  }
}

export function trustModeLabel(mode: TrustMode) {
  switch (mode) {
    case "readonly":
      return "Readonly";
    case "ask":
      return "Manual";
    case "trusted":
      return "Auto";
    case "bypass":
      return "Bypass";
  }
}

export function policyEffectLabel(effect: CapabilityPolicyEffect) {
  switch (effect) {
    case "allow":
      return "Allow";
    case "prompt":
      return "Approval";
    case "deny":
      return "Blocked";
  }
}
