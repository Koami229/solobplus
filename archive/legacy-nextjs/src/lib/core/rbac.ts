import { recordAuditEvent } from './audit';

export type UserRole =
  | 'student'
  | 'teacher'
  | 'org_client'
  | 'contributor'
  | 'reviewer'
  | 'operator'
  | 'admin';

export type Pillar = 'school' | 'business' | 'core';

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  pillar: Pillar;
  preferredUiLang: 'fr' | 'en';
  countryCode: string;
  isActive: boolean;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const SCHOOL_ROLES: UserRole[] = ['student', 'teacher', 'admin'];
export const BUSINESS_ROLES: UserRole[] = ['org_client', 'contributor', 'reviewer', 'operator', 'admin'];
export const OPERATOR_ROLES: UserRole[] = ['operator', 'admin'];

export function resolvePillarForRole(role: UserRole): Pillar {
  if (role === 'student' || role === 'teacher') return 'school';
  if (role === 'org_client' || role === 'contributor' || role === 'reviewer' || role === 'operator') {
    return 'business';
  }
  return 'core';
}

export async function enforceRole(
  user: AuthenticatedUser | null,
  allowedRoles: UserRole[],
  pillar: Pillar,
  operationName: string
): Promise<AuthenticatedUser> {
  if (!user) {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: null,
      pillar,
      action: operationName,
      targetType: 'AUTH_GUARD',
      status: 'DENIED',
      metadata: { reason: 'UNAUTHENTICATED', requiredRoles: allowedRoles },
    });
    throw new AppError('Authentication required to perform this action.', 401, 'UNAUTHENTICATED');
  }

  if (!user.isActive) {
    await recordAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      pillar,
      action: operationName,
      targetType: 'AUTH_GUARD',
      status: 'DENIED',
      metadata: { reason: 'ACCOUNT_DISABLED' },
    });
    throw new AppError('Account is inactive.', 403, 'ACCOUNT_DISABLED');
  }

  if (!allowedRoles.includes(user.role)) {
    await recordAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      pillar,
      action: operationName,
      targetType: 'RBAC_GUARD',
      status: 'DENIED',
      metadata: {
        reason: 'ROLE_FORBIDDEN_CROSS_PILLAR_OR_INSUFFICIENT_PRIVILEGE',
        userRole: user.role,
        userPillar: user.pillar,
        allowedRoles,
        targetPillar: pillar,
      },
    });
    throw new AppError(
      `Role '${user.role}' is not authorized for '${operationName}' in pillar '${pillar}'. Allowed roles: ${allowedRoles.join(', ')}.`,
      403,
      'FORBIDDEN_ROLE'
    );
  }

  return user;
}
