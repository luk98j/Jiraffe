/**
 * What an adapter knows about its CLI. `confirmed` means the owner or the vendor
 * documentation verified it; anything else is `unverified` and must name the spec
 * section 12 item that would confirm it. An unverified entry carries no flag text.
 */
export interface ProfileEntry<A = undefined> {
  status: 'confirmed' | 'unverified';
  spec12Item?: number;
  note: string;
  /** Present only for a confirmed entry that has to build arguments. */
  args?: A;
}
