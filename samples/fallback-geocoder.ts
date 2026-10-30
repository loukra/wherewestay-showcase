import { DomainError } from '../../domain/models/errors.js';
import type { Coordinate } from '../../domain/models/geo.js';
import type {
  GeocodingCandidate,
  GeocodingProvider,
  PointSurroundings,
} from '../../domain/ports/geocoding-provider.js';

/**
 * Faellt nur zurueck, wenn der erste Anbieter *nicht antworten konnte*. Ein
 * Anbieter, der antwortet und nichts findet, hat geantwortet.
 *
 * Das ist die ganze Regel, und sie ist wichtiger, als sie aussieht: Photon
 * findet Adressen, die Pelias nicht kennt -- und Pelias antwortet auf
 * dieselbe Anfrage nicht mit "nichts", sondern mit dem Mittelpunkt der
 * Strasse, gemessen bis zu 1530 m daneben. Wer bei leerem Ergebnis
 * weiterfragte, tauschte damit ein ehrliches "nicht gefunden" gegen eine
 * stille Falschauskunft -- dieselbe Gefahr wie beim Vorfiltern von POIs.
 */
const RETRYABLE = new Set(['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED']);

const isRetryable = (reason: unknown): boolean =>
  reason instanceof DomainError && RETRYABLE.has(reason.code);

export class FallbackGeocodingProvider implements GeocodingProvider {
  constructor(
    private readonly primary: GeocodingProvider,
    private readonly fallback: GeocodingProvider,
  ) {}

  async search(
    address: string,
    limit?: number,
    homeCountry: string | null = null,
  ): Promise<GeocodingCandidate[]> {
    try {
      return await this.primary.search(address, limit, homeCountry);
    } catch (reason) {
      if (!isRetryable(reason)) throw reason;
      return this.fallback.search(address, limit, homeCountry);
    }
  }

  async geocode(address: string): Promise<Coordinate> {
    try {
      return await this.primary.geocode(address);
    } catch (reason) {
      if (!isRetryable(reason)) throw reason;
      return this.fallback.geocode(address);
    }
  }

  async surroundings(
    point: Coordinate,
    homeCountry: string | null = null,
  ): Promise<PointSurroundings> {
    try {
      return await this.primary.surroundings(point, homeCountry);
    } catch (reason) {
      if (!isRetryable(reason)) throw reason;
      return this.fallback.surroundings(point, homeCountry);
    }
  }
}
