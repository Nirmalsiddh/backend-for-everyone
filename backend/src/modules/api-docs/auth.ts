import type { DocsSnapshot, ApiOperation } from './types.js';
import { errors, objectSchema, response, uuid } from './schemas.js';
export function authOperations(config: NonNullable<DocsSnapshot['auth']>) {
  const user = objectSchema(
    {
      id: uuid,
      email: { type: 'string' },
      role: { type: 'string', enum: ['user', 'admin'] },
    },
    ['id', 'email', 'role'],
  );
  return ['signup', 'login', 'me', 'logout']
    .filter((a) => a !== 'signup' || config.signupEnabled)
    .map((action) => {
      const publicAction = action === 'signup' || action === 'login';
      const operation: ApiOperation = {
        operationId: `auth_${action}`,
        tags: ['Authentication'],
        summary: `Application ${action}`,
        description:
          action === 'signup'
            ? 'Create an application user (201). Does not start a session. Email is trimmed and lowercased. Duplicate signup returns a sanitized 409.'
            : action === 'login'
              ? 'Sign in an application user. Send the returned token as Authorization: Bearer <application-session-token>. Invalid credentials return a generic 401.'
              : action === 'logout'
                ? 'Revoke the supplied application session. No request body.'
                : 'Return the signed-in application user. No request body.',
        'x-access-policy': publicAction ? 'public' : 'authenticated',
        security: publicAction ? [] : [{ ApplicationSession: [] }],
        responses: errors([
          400,
          401,
          422,
          500,
          503,
          504,
          ...(publicAction ? [413, 429] : []),
          ...(action === 'signup' ? [409] : []),
        ]),
      };
      if (publicAction)
        operation.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: objectSchema(
                {
                  email: {
                    type: 'string',
                    maxLength: 254,
                    description:
                      'Email address, trimmed and lowercased. Provider-specific normalization is not performed.',
                  },
                  password: {
                    type: 'string',
                    writeOnly: true,
                    minLength: action === 'signup' ? 15 : 1,
                    maxLength: 128,
                    description:
                      'Unicode code points; maximum 512 UTF-8 bytes.',
                  },
                },
                ['email', 'password'],
              ),
              example: {
                email: 'developer@example.test',
                password: 'Example password 2026',
              },
            },
          },
        };
      operation.responses[
        action === 'signup' ? '201' : action === 'logout' ? '204' : '200'
      ] =
        action === 'logout'
          ? response('Application session revoked; no content')
          : action === 'login'
            ? response(
                'Application session created',
                objectSchema(
                  {
                    user,
                    token: {
                      type: 'string',
                      description:
                        'Opaque application session token; never a dashboard session.',
                    },
                    expiresIn: {
                      type: 'integer',
                      description: 'Absolute lifetime in seconds',
                      const: config.sessionLifetimeSeconds,
                    },
                  },
                  ['user', 'token', 'expiresIn'],
                ),
                {
                  user: {
                    id: '00000000-0000-4000-8000-000000000001',
                    email: 'developer@example.test',
                    role: 'user',
                  },
                  token: 'us_example_application_session_token',
                  expiresIn: config.sessionLifetimeSeconds,
                },
              )
            : response('Application user', user, {
                id: '00000000-0000-4000-8000-000000000001',
                email: 'developer@example.test',
                role: 'user',
              });
      return {
        path: `/auth/${action}`,
        method: action === 'me' ? 'get' : 'post',
        operation,
      };
    });
}
