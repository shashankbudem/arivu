export function DoctorReportView({ report }: { report: DoctorReport }) {
  return (
    <section className="doctor-report">
      <div className="doctor-report-heading">
        <strong>Doctor</strong>
        <span>
          {report.summary.pass} pass, {report.summary.warn} warn, {report.summary.fail} fail, {report.summary.skip} skip
        </span>
      </div>
      <div className="doctor-checks">
        {report.capabilityObservations?.map((observation) => (
          <article key={`${observation.checkId}:${observation.capability}`} className="doctor-check warn">
            <span className="doctor-status">saved</span>
            <div>
              <strong>{doctorCapabilityLabel(observation.capability)}</strong>
              <p>Saved as Disabled for this provider based on the doctor check.</p>
            </div>
          </article>
        ))}
        {report.checks.map((entry) => (
          <article key={entry.id} className={`doctor-check ${entry.status}`}>
            <span className="doctor-status">{entry.status}</span>
            <div>
              <strong>{entry.label}</strong>
              <p>{entry.message}</p>
              {entry.detail ? <pre>{entry.detail}</pre> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function doctorCapabilityLabel(capability: DoctorCapabilityObservation["capability"]) {
  return capability === "toolCalling" ? "Tool calling" : "Image input";
}
