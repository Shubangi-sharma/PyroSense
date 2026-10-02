"use client";

import React from "react";
import { CircleMarker, MapContainer, TileLayer } from "react-leaflet";
import { RiskStatus, statusColorHex } from "@/lib/types";
import { CARTO_DARK_URL, CARTO_LABELS_URL } from "./MapInner";

/**
 * Non-interactive locator map for the facility detail page.
 * `satellite` toggles Esri World Imagery (unfiltered) vs the dark OSM style.
 */
export default function MiniMapInner({
  lat,
  lng,
  name,
  satellite = false,
}: {
  lat: number;
  lng: number;
  name: string;
  satellite?: boolean;
}) {
  const hex = statusColorHex("watch" as RiskStatus);

  return (
    <MapContainer
      center={[lat, lng]}
      zoom={satellite ? 13 : 10}
      scrollWheelZoom={false}
      dragging={false}
      doubleClickZoom={false}
      zoomControl={false}
      attributionControl
      className="h-full w-full"
    >
      <TileLayer
        key={satellite ? "sat" : "dark"}
        url={
          satellite
            ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            : CARTO_DARK_URL
        }
        attribution={
          satellite
            ? 'Tiles &copy; Esri - Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
            : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; &copy; <a href="https://carto.com/attributions">CARTO</a>'
        }
      />
      {/* English place names over satellite for orientation */}
      {satellite && (
        <TileLayer
          url={CARTO_LABELS_URL}
          className="pyro-tile-labels"
          attribution="&copy; OpenStreetMap contributors &middot; &copy; CARTO"
        />
      )}
      <CircleMarker
        center={[lat, lng]}
        radius={8}
        pathOptions={{
          color: "#05070A",
          weight: 1.5,
          fillColor: hex,
          fillOpacity: 0.95,
        }}
      />
    </MapContainer>
  );
}
