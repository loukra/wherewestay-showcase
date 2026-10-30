import { DomainError } from '../../domain/models/errors.js';

/** Höchstens `limit` Abrufe in jedem Zeitraum der Länge `windowMs`. */
export type BudgetWindow = { limit: number; windowMs: number; label: string };

export type CallBudgetOptions = {
  windows: BudgetWindow[];
  /**
   * So lange darf ein Abruf auf einen freien Platz warten. Wer länger warten
   * müsste, wird sofort abgewiesen -- ein Tageslimit wartet man nicht ab.
   */
  maxWaitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Für das Log: "Isochronen", "Matrix". */
  name?: string;
  /** Je vergebenem Platz und je Abweisung einmal -- für die Nutzungszeile. */
  onGranted?: () => void;
  onRejected?: () => void;
  log?: (message: string) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Buchführung über die Abrufe bei einem Anbieter mit festen Obergrenzen.
 *
 * **Reserviert wird vor dem Abruf, nicht danach gezählt.** Gehen 25 Abrufe
 * gleichzeitig los, sähen sonst alle denselben Zählerstand, und das Budget
 * wäre um genau so viele überzogen, wie parallel laufen.
 *
 * Jeder Platz ist ein Zeitpunkt. Ist ein Fenster voll, bekommt der Abruf den
 * frühesten Zeitpunkt, an dem in *jedem* Fenster wieder Platz ist -- und
 * wartet bis dahin. Liegt der weiter weg als `maxWaitMs`, wird er abgewiesen.
 * Ein Minutenlimit wird so abgewartet, ein Tageslimit nicht, ohne dass es
 * dafür zwei Mechanismen bräuchte.
 *
 * Die Fenster sind **gleitend**: in *jedem* Zeitraum ihrer Länge höchstens
 * `limit`. Das ist strenger als ein Fenster, das zu einem festen Zeitpunkt
 * zurückgesetzt wird (ORS setzt 24 h nach dem ersten Abruf zurück), und kann
 * deshalb nie mehr durchlassen als der Anbieter.
 */
export class CallBudget {
  /** Vergebene Plätze, aufsteigend; manche liegen in der Zukunft. */
  private readonly slots: number[] = [];
  private readonly windows: BudgetWindow[];
  private readonly longestWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly name: string;
  private readonly onGranted: () => void;
  private readonly onRejected: () => void;
  private readonly log: (message: string) => void;
  /**
   * Ob gerade abgewiesen wird. Geloggt wird nur der **Wechsel**: Eine Zeile je
   * abgewiesener Anfrage wären bei vollem Budget bis zu 120 je Minute und
   * Absender -- dann steht im Log nichts anderes mehr. Wie viele es waren,
   * sagt die Nutzungszeile.
   */
  private refusing = false;

  constructor(options: CallBudgetOptions) {
    this.windows = options.windows;
    this.longestWindowMs = Math.max(
      0,
      ...options.windows.map((window) => window.windowMs),
    );
    this.maxWaitMs = options.maxWaitMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.name = options.name ?? 'Budget';
    this.onGranted = options.onGranted ?? (() => {});
    this.onRejected = options.onRejected ?? (() => {});
    this.log = options.log ?? console.warn;
  }

  /**
   * Belegt einen Platz und wartet, bis er dran ist. Wirft
   * `PROVIDER_RATE_LIMITED`, wenn keiner in Reichweite ist -- ohne etwas zu
   * belegen.
   */
  async acquire(): Promise<void> {
    const time = this.now();
    this.forgetBefore(time - this.longestWindowMs);

    let slot = Math.max(time, this.slots.at(-1) ?? time);
    let blocking: BudgetWindow | null = null;

    for (const window of this.windows) {
      // In (slot - windowMs, slot] dürfen höchstens limit - 1 andere liegen.
      // Weil alle vergebenen Plätze <= slot sind, ist das der Platz, der
      // limit Stellen vor dem Ende steht.
      const oldestThatCounts = this.slots[this.slots.length - window.limit];
      if (oldestThatCounts !== undefined && oldestThatCounts + window.windowMs > slot) {
        slot = oldestThatCounts + window.windowMs;
        blocking = window;
      }
    }

    if (slot - time > this.maxWaitMs) {
      this.onRejected();
      if (!this.refusing) {
        this.refusing = true;
        this.log(
          `[budget] ${this.name}: ${blocking?.label ?? 'Grenze'} erreicht, nächster Platz in ` +
            `${Math.ceil((slot - time) / 1000)} s. Bis dahin wird abgewiesen.`,
        );
      }
      // Ohne Details: Der Error-Handler loggte sie sonst bei jeder
      // abgewiesenen Anfrage. Der Grund steht einmal in der Zeile oben.
      throw new DomainError(
        'PROVIDER_RATE_LIMITED',
        'Das Anfragelimit des Kartendienstes ist erreicht. Bitte versuche es später erneut.',
      );
    }

    if (this.refusing) {
      this.refusing = false;
      this.log(`[budget] ${this.name}: wieder Platz.`);
    }
    this.onGranted();
    this.slots.push(slot);
    if (slot > time) await this.sleep(slot - time);
  }

  /** Belegte Plätze im längsten Fenster -- für Tests und Auskunft. */
  used(): number {
    this.forgetBefore(this.now() - this.longestWindowMs);
    return this.slots.length;
  }

  private forgetBefore(limit: number): void {
    let expired = 0;
    while (expired < this.slots.length && (this.slots[expired] as number) <= limit)
      expired += 1;
    if (expired > 0) this.slots.splice(0, expired);
  }
}
