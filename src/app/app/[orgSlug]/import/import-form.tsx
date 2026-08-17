"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ImportFormState } from "./actions";

type ImportAction = (prevState: ImportFormState, formData: FormData) => Promise<ImportFormState>;

/** Detail rows past this count are summarized instead of rendered — the counts above the table are always exact for every row, regardless of this cap. */
const MAX_DISPLAYED_ROWS = 500;

export function ImportForm({
  action,
  submitLabel,
}: {
  action: ImportAction;
  submitLabel: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="file">CSV file</Label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className="flex h-10 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
          />
        </div>
        <Button type="submit" disabled={isPending} className="self-start">
          {isPending ? "Importing…" : submitLabel}
        </Button>
      </form>

      {state?.kind === "rejected" ? <Alert tone="danger">{state.reason}</Alert> : null}

      {state?.kind === "completed" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3">
            <Badge tone="neutral">{state.summary.totalRows} row{state.summary.totalRows === 1 ? "" : "s"}</Badge>
            <Badge tone="success">{state.summary.created} created</Badge>
            <Badge tone="info">{state.summary.skipped} skipped</Badge>
            <Badge tone={state.summary.failed > 0 ? "danger" : "neutral"}>{state.summary.failed} failed</Badge>
          </div>

          {state.summary.rows.length > 0 ? (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.summary.rows.slice(0, MAX_DISPLAYED_ROWS).map((row) => (
                    <TableRow key={row.sourceRow}>
                      <TableCell className="tabular-nums text-muted">{row.sourceRow}</TableCell>
                      <TableCell>
                        <Badge
                          tone={row.status === "created" ? "success" : row.status === "skipped" ? "info" : "danger"}
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-foreground">{row.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}

          {state.summary.rows.length > MAX_DISPLAYED_ROWS ? (
            <p className="text-xs text-muted">
              Showing the first {MAX_DISPLAYED_ROWS} of {state.summary.rows.length} rows — the counts above are exact
              for the whole file.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
