/**
 * Current user route (GET /api/v4/user).
 */

import { Hono } from 'hono';
import { ADO_API_VERSION } from '../constants.js';
import { MappingService } from '../mapping.js';
import type { Env } from './env.js';
import type { ADOUserProfile } from '../types.js';

export function registerUser(app: Hono<Env>): void {
  app.get('/api/v4/user', async (c) => {
    const { ctx } = c.var;

    try {
      // Try ConnectionData API first (organization-level endpoint).
      // Note: ConnectionData requires -preview suffix for version 7.1.
      const connectionDataApiVersion = `${ADO_API_VERSION}-preview`;
      const connectionDataUrl = MappingService.buildAdoUrl(
        ctx.config.adoBaseUrl,
        '/_apis/ConnectionData',
        undefined,
        connectionDataApiVersion
      );

      console.log('[GET /api/v4/user] Attempting ConnectionData API:', {
        url: connectionDataUrl,
        method: 'GET',
        hasAuth: !!ctx.adoAuthHeader,
      });

      let response = await fetch(connectionDataUrl, {
        method: 'GET',
        headers: {
          Authorization: ctx.adoAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      let usedFallback = false;
      let profileUrl = connectionDataUrl;

      // If ConnectionData fails, try Profile API as fallback.
      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[GET /api/v4/user] ConnectionData API failed:', {
          status: response.status,
          statusText: response.statusText,
          url: connectionDataUrl,
          error: errorText,
          headers: Object.fromEntries(response.headers.entries()),
        });

        // Extract organization from base URL.
        const orgMatch = ctx.config.adoBaseUrl.match(/dev\.azure\.com\/([^\/]+)/);
        const org = orgMatch ? orgMatch[1] : '';

        // Try Profile API endpoint.
        profileUrl = `https://vssps.dev.azure.com/${org}/_apis/profile/profiles/me?api-version=5.1`;
        console.log('[GET /api/v4/user] Falling back to Profile API:', {
          url: profileUrl,
          organization: org,
        });

        usedFallback = true;
        response = await fetch(profileUrl, {
          method: 'GET',
          headers: {
            Authorization: ctx.adoAuthHeader,
            'Content-Type': 'application/json',
          },
        });
      }

      // Check content type before processing.
      const contentType = response.headers.get('Content-Type') ?? '';
      const isJson = contentType.includes('application/json') || contentType.includes('text/json');

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GET /api/v4/user] All user API attempts failed:', {
          status: response.status,
          statusText: response.statusText,
          contentType,
          isJson,
          error: isJson ? errorText : errorText.substring(0, 500),
          usedFallback,
          url: profileUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: isJson ? errorText : `Received ${contentType} instead of JSON. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      // Check if response is actually JSON before parsing.
      if (!isJson) {
        const responseText = await response.text();
        console.error('[GET /api/v4/user] Non-JSON response received:', {
          contentType,
          status: response.status,
          responsePreview: responseText.substring(0, 500),
          url: profileUrl,
        });
        return c.json(
          {
            error: 'ADO API Error',
            message: `Expected JSON but received ${contentType}. This may indicate an authentication or endpoint issue.`,
            statusCode: response.status,
          },
          response.status as 400 | 401 | 403 | 404 | 500
        );
      }

      const responseData = (await response.json()) as
        | {
            authenticatedUser: {
              id: string;
              descriptor: string;
              subjectDescriptor: string;
              providerDisplayName: string;
              isActive: boolean;
              properties: {
                Account?: { $value: string };
              };
            };
          }
        | ADOUserProfile
        | Record<string, unknown>;

      console.log('[GET /api/v4/user] Success:', {
        usedFallback,
        responseType: 'authenticatedUser' in responseData ? 'ConnectionData' : 'Profile',
        hasData: !!responseData,
        dataKeys: Object.keys(responseData),
      });

      // Handle ConnectionData response format.
      if ('authenticatedUser' in responseData && responseData.authenticatedUser) {
        const data = responseData as {
          authenticatedUser: {
            id: string;
            descriptor: string;
            subjectDescriptor: string;
            providerDisplayName: string;
            isActive: boolean;
            properties: {
              Account?: { $value: string };
            };
          };
        };

        console.log('[GET /api/v4/user] Parsed ConnectionData response:', {
          userId: data.authenticatedUser.id,
          displayName: data.authenticatedUser.providerDisplayName,
          hasEmail: !!data.authenticatedUser.properties?.Account?.$value,
        });

        const user = MappingService.mapUserProfileToUser({
          id: data.authenticatedUser.id,
          displayName: data.authenticatedUser.providerDisplayName,
          publicAlias: data.authenticatedUser.providerDisplayName,
          emailAddress: data.authenticatedUser.properties?.Account?.$value ?? '',
          coreRevision: 0,
          timeStamp: new Date().toISOString(),
          revision: 0,
        });

        return c.json(user);
      }

      // Handle Profile API response format.
      if ('id' in responseData || 'displayName' in responseData) {
        const profile = responseData as ADOUserProfile;
        console.log('[GET /api/v4/user] Parsed Profile API response:', {
          userId: profile.id,
          displayName: profile.displayName,
          email: profile.emailAddress,
          publicAlias: profile.publicAlias,
        });

        const user = MappingService.mapUserProfileToUser(profile);
        return c.json(user);
      }

      // If we can't parse the response, return a generic user.
      console.warn('[GET /api/v4/user] Unexpected response format:', {
        responseData,
        keys: Object.keys(responseData),
        usedFallback,
      });
      const user = MappingService.mapUserProfileToUser({
        id: 'unknown',
        displayName: 'User',
        publicAlias: 'user',
        emailAddress: '',
        coreRevision: 0,
        timeStamp: new Date().toISOString(),
        revision: 0,
      });

      return c.json(user);
    } catch (error) {
      console.error('[GET /api/v4/user] Exception:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return c.json(
        {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          statusCode: 500,
        },
        500
      );
    }
  });
}
