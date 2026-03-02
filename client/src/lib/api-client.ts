// API Client for Medical Representative Backend
// Configure this to point to your backend server

export const API_URL = "/api/v1";

export interface ApiError extends Error {
  status?: number;
}

/**
 * Wrapper around fetch to handle auth headers and error parsing
 */
export async function apiClient<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ statusCode: number; data: T; message?: string }> {
  const token = localStorage.getItem("accessToken");

  const headers: HeadersInit = {
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }

  // Auto-set Content-Type to JSON unless it's FormData (file upload)
  if (!(options.body instanceof FormData)) {
    (headers as Record<string, string>)["Content-Type"] = "application/json";
  }

  const config: RequestInit = {
    ...options,
    headers,
  };

  try {
    const response = await fetch(`${API_URL}${endpoint}`, config);

    // Handle 401 Unauthorized (token expired)
    if (response.status === 401) {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("user");

      // Redirect to login if not already there
      if (!window.location.pathname.includes("/login")) {
        window.location.href = "/login";
      }

      const error: ApiError = new Error("Session expired");
      error.status = 401;
      throw error;
    }

    // Check if response is JSON
    const contentType = response.headers.get("content-type");
    let data: any;

    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      const text = await response.text();
      console.error("Non-JSON response received:", text.substring(0, 100));
      const error: ApiError = new Error(`Server returned non-JSON response (${response.status})`);
      error.status = response.status;
      throw error;
    }

    if (!response.ok) {
      const error: ApiError = new Error(data.message || "API request failed");
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if ((error as any).status === 401) {
      // already handled above but re-throw to stop execution
      throw error;
    }
    console.error("API Error:", error);
    throw error;
  }
}
