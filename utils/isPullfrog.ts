/**
 * true when a GitHub login belongs to Pullfrog's production or development app.
 */
export function isPullfrog(actor: string | null | undefined): boolean {
  actor = actor?.toLowerCase().replace("[bot]", "");
  return !!actor && (actor === "pullfrog" || actor === "pullfrogdev");
}
