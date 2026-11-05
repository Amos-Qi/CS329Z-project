/**
 * Level 4 (researchers): the raw event table — seq, type, JSON (`.raw`, `.rawt` in styles.css).
 * Every event exactly as the server recorded it, oldest first, up to the replay position.
 */

import type { TraceEvent } from "@vcm/protocol";
import { memo } from "react";

/** Props of RawView. */
export interface RawViewProps {
	/** The events to list (already sliced to the replay position). */
	events: readonly TraceEvent[];
}

/** `<section class="raw">`. Memoized: the live clock re-renders the app every second, the events rarely change. */
export const RawView = memo(function RawView({ events }: RawViewProps) {
	return (
		<section className="raw" aria-label="Raw events">
			<table className="rawt" aria-label={`Trace events, ${events.length}, oldest first`}>
				<thead>
					<tr>
						<th scope="col">seq</th>
						<th scope="col">type</th>
						<th scope="col">JSON</th>
					</tr>
				</thead>
				<tbody>
					{events.map((e) => (
						<tr key={e.seq}>
							<td className="sq">{e.seq}</td>
							<td className="ty">{e.type}</td>
							<td className="js">{JSON.stringify(e)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
});
