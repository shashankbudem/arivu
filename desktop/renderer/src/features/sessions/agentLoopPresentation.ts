export function agentLoopStatusFromEvent(event: SessionLifecycleEvent) {
  return event.agentLoop ? agentLoopStatusLabel(event.agentLoop) : null;
}

export function agentLoopStatusLabel(loop: AgentLoopState) {
  const progress = `${loop.iteration}/${loop.maxIterations}`;
  if (loop.status === "running") {
    return `Agent loop ${progress}`;
  }
  if (loop.status === "stopping") {
    return `Stopping loop ${progress}`;
  }
  if (loop.status === "completed") {
    return `Loop completed in ${loop.iteration} ${loop.iteration === 1 ? "iteration" : "iterations"}`;
  }
  if (loop.status === "stopped") {
    return `Loop stopped at ${progress}`;
  }
  if (loop.status === "blocked") {
    return `Loop blocked at ${progress}`;
  }
  if (loop.status === "failed") {
    return `Loop failed at ${progress}`;
  }
  return `Loop reached ${loop.maxIterations} iterations`;
}

export function agentLoopRunStatusLabel(status: AgentLoopStatus) {
  switch (status) {
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "max_iterations":
      return "max iterations";
  }
}

export function agentLoopIterationStatusLabel(status: AgentLoopIterationStatus) {
  switch (status) {
    case "running":
      return "Running";
    case "continued":
      return "Continued";
    case "completed":
      return "Completed";
    case "stopped":
      return "Stopped";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "max_iterations":
      return "Max iterations";
  }
}
