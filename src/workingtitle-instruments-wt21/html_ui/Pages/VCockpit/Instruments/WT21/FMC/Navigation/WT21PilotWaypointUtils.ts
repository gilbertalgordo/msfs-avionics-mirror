import {
  Facility, FacilityLoader, FlightPlan, GeoCircle, GeoPoint, ICAO, LegType, LNavVars, SimVarValueType, UnitType, UserFacility, UserFacilityUtils
} from '@microsoft/msfs-sdk';
import { WT21Fms } from '../../Shared/FlightPlan/WT21Fms';
import { WT21CoordinatesUtils } from './WT21CoordinatesUtils';

export const PBD_REGEX = /^(\w+)(\d{3}(?:\.\d)?)\/(\d{1,3}(?:\.\d)?)(?:\/(\w+))?$/;

export const PBPB_REGEX = /^(\w+)(\d{3}(?:\.\d)?)\/(\w+)(\d{3}(?:\.\d)?)(?:\/(\w+))?$/;

export const ATO_REGEX = /^(\w+)\/([+-]?\d{1,3}(?:\.\d)?)(?:\/(\w+))?$/;

// This should technically be only TF, but that doesn't make much sense and seems like a mistake
const ATO_VALID_PREVIOUS_LEG_TYPES = [LegType.CF, LegType.DF, LegType.IF, LegType.TF, LegType.RF];

const ATO_VALID_NEXT_LEG_TYPES = [LegType.IF, LegType.TF];

/**
 * Input/output data for a PBD entry
 */
export interface PlaceBearingDistanceInput {
  /**
   * Place identifier
   */
  placeIdent: string,
  /**
   * Bearing
   */
  bearing: number,
  /**
   * Distance
   */
  distance: number,
  /**
   * Ident to give to the new facility
   */
  newIdent?: string,
}

/**
 * Input/output data for a PB/PB entry
 */
export interface PlaceBearingPlaceBearingInput {
  /**
   * Place A identifier
   */
  placeAIdent: string,

  /**
   * Bearing from place A
   */
  bearingA: number,

  /**
   * Place B identifier
   */
  placeBIdent: string,

  /**
   * Bearing from place B
   */
  bearingB: number,

  /**
   * Ident to give to the new facility
   */
  newIdent: string,
}

/**
 * Input/output data for an ATO entry
 */
export interface AlongTrackOffsetInput {
  /**
   * Place identifier
   */
  placeIdent: string;

  /**
   * Distance
   */
  distance: number;

  /**
   * Ident to give to the new facility
   */
  newIdent: string;
}

/**
 * Error that can occur when creating an ATO waypoint
 */
export enum AlongTrackOffsetError {
  NotAvailable,
  DistanceTooLarge,
}

/**
 * Utilities for WT21 pilot defined waypoints
 */
export class WT21PilotWaypointUtils {
  /**
   * Returns whether the limit number of pilot defined waypoints is reached
   *
   * @param facilities the existing user facilities
   *
   * @returns a boolean
   */
  public static isLimitReached(facilities: UserFacility[]): boolean {
    return facilities.length >= 100;
  }

  /**
   * Returns the next available auto-generated name, given existing user facilities and an ident
   *
   * @param facilities the existing user facilities
   * @param ident      the ident of the facility
   *
   * @returns a string to be used as an ident for a user facility
   */
  public static nextAutoGeneratedName(facilities: UserFacility[], ident: string): string {
    let suffix = 1;

    for (const facility of facilities) {
      const facIdent = ICAO.getIdent(facility.icao);

      if (facIdent.match(`${ident.substring(0, 3)}\\d\\d`)) {
        suffix++;
      }
    }

    return `${ident.substring(0, 3)}${suffix.toString().padStart(2, '0')}`;
  }

  /**
   * Converts a scratchpad entry made on a provided {@link FmcPage} to a {@link UserFacility} if applicable
   *
   * @param fms                  the {@link WT21Fms} instance
   * @param selectWptFromIdent   the function called to select a facility
   * @param scratchpadContents   the scratchpad contents
   * @param targetGlobalLegIndex the target global leg index, if applicable
   *
   * @returns a user facility, or null if none is parsed
   */
  public static async createFromScratchpadEntry(
    fms: WT21Fms,
    selectWptFromIdent: (ident: string, refPos: GeoPoint) => Promise<Facility | null>,
    scratchpadContents: string,
    targetGlobalLegIndex?: number,
  ): Promise<[fac: UserFacility, insertAfter: boolean] | null> {
    const pbdMatch = WT21PilotWaypointUtils.parsePlaceBearingDistance(scratchpadContents);

    if (pbdMatch) {
      const existingUserFacilities = fms.getUserFacilities();

      if (WT21PilotWaypointUtils.isLimitReached(existingUserFacilities)) {
        return Promise.reject('PILOT WPT LIST FULL');
      }

      const facility = await selectWptFromIdent(pbdMatch.placeIdent, fms.ppos);

      if (facility) {
        const usrPos = WT21PilotWaypointUtils.createPlaceBearingDistance(facility, pbdMatch.bearing, false, pbdMatch.distance);
        const ident = pbdMatch.newIdent ?? WT21PilotWaypointUtils.nextAutoGeneratedName(existingUserFacilities, ICAO.getIdent(facility.icao));

        return [UserFacilityUtils.createFromLatLon(`U      ${ident}`, usrPos.lat, usrPos.lon), false];
      } else {
        return Promise.reject('NOT IN DATA BASE');
      }
    }

    const pbpbMatch = WT21PilotWaypointUtils.parsePlaceBearingPlaceBearing(scratchpadContents);

    if (pbpbMatch) {
      const existingUserFacilities = fms.getUserFacilities();

      if (WT21PilotWaypointUtils.isLimitReached(existingUserFacilities)) {
        return Promise.reject('PILOT WPT LIST FULL');
      }

      const facilityA = await selectWptFromIdent(pbpbMatch.placeAIdent, fms.ppos);
      const facilityB = await selectWptFromIdent(pbpbMatch.placeBIdent, fms.ppos);

      if (facilityA && facilityB) {
        const usrPos = WT21PilotWaypointUtils.createPlaceBearingPlaceBearing(
          facilityA, pbpbMatch.bearingA, facilityB, pbpbMatch.bearingB,
        );

        if (!usrPos) {
          return Promise.reject('NO INTERSECTION');
        }

        const ident = pbpbMatch.newIdent ?? WT21PilotWaypointUtils.nextAutoGeneratedName(existingUserFacilities, ICAO.getIdent(facilityA.icao));

        return [UserFacilityUtils.createFromLatLon(`U      ${ident}`, usrPos.lat, usrPos.lon), false];
      } else {
        return Promise.reject('NOT IN DATA BASE');
      }
    }

    const atoMatch = WT21PilotWaypointUtils.parseAlongTrackOffset(scratchpadContents);

    if (atoMatch) {
      if (targetGlobalLegIndex === undefined) {
        throw new Error('Along-track offset can only be created by createFromScratchpadEntry is a target global leg index is specified');
      }

      const existingUserFacilities = fms.getUserFacilities();

      if (WT21PilotWaypointUtils.isLimitReached(existingUserFacilities)) {
        return Promise.reject('PILOT WPT LIST FULL');
      }

      const plan = fms.getPlanForFmcRender();

      const lnavActiveLegIndex = SimVar.GetSimVarValue(LNavVars.TrackedLegIndex, SimVarValueType.Number);
      const lnavActiveLegDistanceAlong = SimVar.GetSimVarValue(LNavVars.LegDistanceAlong, SimVarValueType.NM);

      const result = await WT21PilotWaypointUtils.createAlongTrackOffset(
        fms.facLoader, plan, targetGlobalLegIndex, lnavActiveLegIndex, lnavActiveLegDistanceAlong, atoMatch.distance,
      );

      if (!Array.isArray(result)) {
        if (result === AlongTrackOffsetError.DistanceTooLarge) {
          return Promise.reject('DISTANCE TOO LARGE');
        } else {
          return Promise.reject('ALONG TRK WPT N/A');
        }
      }

      const [usrPos, insertAfter] = result;

      const leg = plan.getLeg(targetGlobalLegIndex);

      const ident = atoMatch.newIdent ?? WT21PilotWaypointUtils.nextAutoGeneratedName(existingUserFacilities, leg.name ?? 'USR');

      return [UserFacilityUtils.createFromLatLon(`U      ${ident}`, usrPos.lat, usrPos.lon), insertAfter];
    }

    const coordinatesMatch = WT21CoordinatesUtils.parseLatLong(scratchpadContents);

    if (coordinatesMatch) {
      const existingUserFacilities = fms.getUserFacilities();

      if (WT21PilotWaypointUtils.isLimitReached(existingUserFacilities)) {
        return Promise.reject('PILOT WPT LIST FULL');
      }

      const ident = coordinatesMatch.ident ?? WT21PilotWaypointUtils.nextAutoGeneratedName(existingUserFacilities, 'LLA');

      return [UserFacilityUtils.createFromLatLon(`U      ${ident}`, coordinatesMatch.lla.lat, coordinatesMatch.lla.long), false];
    }

    return null;
  }

  /**
   * Parses a string according to the PB/D format
   *
   * @param str the string to parse
   *
   * @returns a {@link PlaceBearingDistanceInput} object if a valid PBD definition and `null` otherwise
   */
  public static parsePlaceBearingDistance(str: string): PlaceBearingDistanceInput | null {
    const match = str.match(PBD_REGEX);

    if (!match) {
      return null;
    }

    const bearing = parseFloat(match[2]);

    if (bearing < 0 || bearing > 360) {
      return null;
    }

    return {
      placeIdent: match[1],
      bearing,
      distance: parseFloat(match[3]),
      newIdent: match[4],
    };
  }

  /**
   * Creates a PB/D position with input data
   *
   * @param facility    the facility representing the origin
   * @param bearing     the bearing to use
   * @param bearingTrue whether the bearing is already provided in TRUE form
   * @param distance    the distance to use
   *
   * @returns a {@link GeoPoint}
   */
  public static createPlaceBearingDistance(
    facility: Facility,
    bearing: number,
    bearingTrue: boolean,
    distance: number,
  ): GeoPoint {
    const outPoint = new GeoPoint(0, 0);
    const inPoint = new GeoPoint(facility.lat, facility.lon);

    let finalBearing;
    if (bearingTrue) {
      finalBearing = bearing;
    } else {
      const magvar = Facilities.getMagVar(facility.lat, facility.lon);

      finalBearing = bearing + magvar;
    }

    inPoint.offset(finalBearing, UnitType.GA_RADIAN.convertFrom(distance, UnitType.NMILE), outPoint);

    return outPoint;
  }

  /**
   * Parses a string according to the PB/PB format
   *
   * @param str the string to parse
   *
   * @returns a {@link PlaceBearingPlaceBearingInput} object if a valid PBPB definition and `null` otherwise
   */
  public static parsePlaceBearingPlaceBearing(str: string): PlaceBearingPlaceBearingInput | null {
    const match = str.match(PBPB_REGEX);

    if (!match) {
      return null;
    }

    const bearingA = parseFloat(match[2]);
    const bearingB = parseFloat(match[4]);

    if (bearingA < 0 || bearingA > 360 || bearingA < 0 || bearingB > 360) {
      return null;
    }

    return {
      placeAIdent: match[1],
      bearingA,
      placeBIdent: match[3],
      bearingB,
      newIdent: match[5],
    };
  }

  /**
   * Creates a PB/PB position with input data
   *
   * @param facilityA   the facility representing the first origin
   * @param bearingA     the bearing to use from the first origin
   * @param facilityB   the facility representing the second origin
   * @param bearingB    the distance to use from the second origin
   *
   * @returns a {@link GeoPoint}
   */
  public static createPlaceBearingPlaceBearing(
    facilityA: Facility,
    bearingA: number,
    facilityB: Facility,
    bearingB: number,
  ): GeoPoint | null {
    const inPointA = new GeoPoint(facilityA.lat, facilityA.lon);
    const circleA = GeoCircle.createGreatCircleFromPointBearing(inPointA, bearingA);

    const inPointB = new GeoPoint(facilityB.lat, facilityB.lon);
    const circleB = GeoCircle.createGreatCircleFromPointBearing(inPointB, bearingB);

    const out: GeoPoint[] = [];

    const numIntersections = circleA.intersectionGeoPoint(circleB, out);

    if (numIntersections !== 2) {
      return null;
    }

    const intersection1 = out[0];
    const intersection2 = out[1];

    const distance1 = intersection1.distance(inPointA);
    const distance2 = intersection2.distance(inPointA);

    if (distance1 < distance2) {
      return intersection1;
    } else {
      return intersection2;
    }
  }

  /**
   * Parses a string according to the along-track offset format
   *
   * @param str the string to parse
   *
   * @returns a {@link AlongTrackOffsetInput} object if a valid ATO definition and `null` otherwise
   */
  public static parseAlongTrackOffset(str: string): AlongTrackOffsetInput | null {
    const match = str.match(ATO_REGEX);

    if (!match) {
      return null;
    }

    return {
      placeIdent: match[1],
      distance: parseFloat(match[2]),
      newIdent: match[3],
    };
  }

  /**
   * Creates an along-track offset position with input data
   *
   * @param facLoader                  the facility loader
   * @param plan                       the flight plan the ATO is being created from
   * @param globalLegIndex             the global leg index in the plan the ATO is being created from (WT21: LSK position)
   * @param lnavActiveLegIndex         the active lnav leg index (not nominal)
   * @param lnavDistanceAlongActiveLeg the distance flown along the active lnav leg
   * @param distance       the distance input
   *
   * @returns a {@link GeoPoint}
   */
  public static async createAlongTrackOffset(
    facLoader: FacilityLoader,
    plan: FlightPlan,
    globalLegIndex: number,
    lnavActiveLegIndex: number,
    lnavDistanceAlongActiveLeg: number,
    distance: number,
  ): Promise<[point: GeoPoint, insertAfter: boolean] | AlongTrackOffsetError> {
    const planLeg = plan.tryGetLeg(globalLegIndex);

    if (planLeg) {
      const distanceNegative = distance < 0;

      // Check for the previous leg type being valid if the distance is negative
      if (distanceNegative) {
        const previousPlanLeg = plan.tryGetLeg(globalLegIndex - 1);

        if (previousPlanLeg) {
          const previousLegType = previousPlanLeg.leg.type;

          if (!ATO_VALID_PREVIOUS_LEG_TYPES.includes(previousLegType)) {
            return AlongTrackOffsetError.NotAvailable;
          }
        } else {
          return AlongTrackOffsetError.NotAvailable;
        }
      }

      let fixIcao1: string | undefined = undefined;
      let fixIcao2: string | undefined = undefined;
      let facility1: Facility | undefined = undefined;
      let facility2: Facility | undefined = undefined;

      if (distanceNegative) {
        const previousPlanLeg = plan.tryGetLeg(globalLegIndex - 1);

        if (previousPlanLeg) {
          const previousLegType = previousPlanLeg.leg.type;
          const legType = planLeg.leg.type;

          if (ATO_VALID_PREVIOUS_LEG_TYPES.includes(previousLegType) && ATO_VALID_NEXT_LEG_TYPES.includes(legType)) {
            let maxDistance = planLeg.calculated ? UnitType.NMILE.convertFrom(planLeg.calculated.distance, UnitType.METER) : -1;

            if (lnavActiveLegIndex === globalLegIndex) {
              maxDistance -= lnavDistanceAlongActiveLeg;
              maxDistance = Math.max(0, maxDistance);
            }

            if (Math.abs(distance) < maxDistance) {
              fixIcao1 = previousPlanLeg.leg.fixIcao;
              fixIcao2 = planLeg.leg.fixIcao;
            } else {
              return AlongTrackOffsetError.DistanceTooLarge;
            }
          }
        }
      } else {
        const nextPlanLeg = plan.tryGetLeg(globalLegIndex + 1);

        if (nextPlanLeg) {
          const legType = planLeg.leg.type;
          const nextLegType = nextPlanLeg.leg.type;

          if (ATO_VALID_PREVIOUS_LEG_TYPES.includes(legType) && ATO_VALID_NEXT_LEG_TYPES.includes(nextLegType)) {
            const maxDistance = nextPlanLeg.calculated ? UnitType.NMILE.convertFrom(nextPlanLeg.calculated.distance, UnitType.METER) : -1;

            let minDistance = 0;
            if (lnavActiveLegIndex === globalLegIndex + 1) {
              minDistance = lnavDistanceAlongActiveLeg;
            }

            if (distance > minDistance && distance < maxDistance) {
              fixIcao1 = planLeg.leg.fixIcao;
              fixIcao2 = nextPlanLeg.leg.fixIcao;
            } else {
              return AlongTrackOffsetError.DistanceTooLarge;
            }
          } else {
            return AlongTrackOffsetError.NotAvailable;
          }
        }
      }

      if (fixIcao1 && fixIcao1 !== ICAO.emptyIcao && fixIcao2 && fixIcao2 !== ICAO.emptyIcao) {
        facility1 = await facLoader.getFacility(ICAO.getFacilityType(fixIcao1), fixIcao1);
        facility2 = await facLoader.getFacility(ICAO.getFacilityType(fixIcao2), fixIcao2);

        if (facility1 && facility2) {
          const circle = GeoCircle.createGreatCircle(facility1, facility2);

          const offsetOut = new Float64Array(3);
          circle.offsetDistanceAlong(distanceNegative ? facility2 : facility1, UnitType.GA_RADIAN.convertFrom(distance, UnitType.NMILE), offsetOut);

          const geoPoint = new GeoPoint(0, 0);
          geoPoint.setFromCartesian(offsetOut);

          return [geoPoint, !distanceNegative];
        }
      }
    }

    return AlongTrackOffsetError.NotAvailable;
  }
}