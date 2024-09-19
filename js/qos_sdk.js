/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const ddRum = window.DD_RUM;

// === Define and initialize QoS event work variables ===
// timing control and auxiliary variables
var hasBeenPlayingVideo = false;
var lastReadyTime = -1; // milliseconds since Epoch, UTC, for computing startupLatencyMsOfThisSession
var lastInitializedTime = -1; // milliseconds since Epoch, UTC, for computing timeToVideoMs
var lastPlayerState = "";
var lastPlayerStateUpdateOrPlaybackSummaryEventSentTime = -1; // milliseconds since Epoch, UTC, for computing playing/bufferingTimeMsInLastMinute
var lastPlaybackStartOrPlaybackSummaryEventSentTime = -1; // milliseconds since Epoch, UTC, for the timing of sending playback summary events

// payload of events
var userId = ""; // unique UUID of each device if localStorage is supported, otherwise set to sessionId of each playback session
var sessionId = ""; // unique UUID of each playback session
var startupLatencyMsOfThisSession = 0;
var timeToVideoMs = 0;
var playingTimeMsInLastMinute = 0;
var bufferingTimeMsInLastMinute = 0;
var bufferingCountInLastMinute = 0;
var errorCountInLastMinute = 0;
var lastQuality = undefined; // the latest rendition being played
// === Define and initialize QoS event work variables ===
// store whether this is a live channel

// store the channel name
var channelWatched = "";

function initializeQoS(player, playbackUrl) {
  console.log("Initializing...:%s", playbackUrl);
  const PlayerState = window.IVSPlayer.PlayerState;
  const PlayerEventType = window.IVSPlayer.PlayerEventType;

  channelWatched = getChannelWatched(playbackUrl);
  console.log("Player...:%j", PlayerState);

  // Attach event (player state) listeners
  player.addEventListener(PlayerState.READY, function () {
    console.log("Player State - READY1");

    // === Send off playback end event and reset QoS event work variables ===

    if (hasBeenPlayingVideo) {
      sendOffLastPlaybackSummaryEvent(player);
    }

    hasBeenPlayingVideo = true;
    lastReadyTime = Date.now();
    setPlayerStateVariables("READY");

    setUserIDSessionID(player);
    startupLatencyMsOfThisSession = 0;
    playingTimeMsInLastMinute = 0;
    bufferingTimeMsInLastMinute = 0;
    bufferingCountInLastMinute = 0;
    errorCountInLastMinute = 0;
    lastQuality = undefined;
    // === Send off playback end event and reset QoS event work variables ===
  });

  player.addEventListener(PlayerState.BUFFERING, function () {
    console.log("Player State - BUFFERING");

    // === Update QoS event work variables ===
    if (lastPlayerState == "PLAYING") {
      // PLAYING -> BUFFERING (can only happen in the middle of a playback session)
      playingTimeMsInLastMinute +=
        Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
      bufferingCountInLastMinute += 1;
    }

    setPlayerStateVariables("BUFFERING");
    // === Update QoS event work variables ===
  });

  player.addEventListener(PlayerState.PLAYING, function () {
    console.log("Player State - PLAYING");

    if (startupLatencyMsOfThisSession == 0) {
      // the very beginning of a playback session
      lastPlaybackStartOrPlaybackSummaryEventSentTime = Date.now();
      startupLatencyMsOfThisSession = Date.now() - lastReadyTime;
      console.log(
        "startupLatencyMsOfThisSession: " + startupLatencyMsOfThisSession
      );

      timeToVideoMs = Date.now() - lastInitializedTime;
      console.log("timeToVideoMs: " + timeToVideoMs);
      // sendPlaybackStartEvent(player);

      if (lastQuality === undefined) {
        lastQuality = player.getQuality();
      }
    } else {
      if (lastPlayerState == "BUFFERING") {
        // BUFFERING -> PLAYING (in the middle of a playback session)
        bufferingTimeMsInLastMinute +=
          Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
      }
    }

    setPlayerStateVariables("PLAYING");
    // === Send off playback start event and update QoS event work variables ===
  });

  player.addEventListener(PlayerState.IDLE, function () {
    console.log("Player State - IDLE");

    // === Update QoS event work variables ===
    if (lastPlayerState == "PLAYING") {
      // PLAYING -> IDLE
      playingTimeMsInLastMinute +=
        Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
    } else if (lastPlayerState == "BUFFERING") {
      // BUFFERING -> IDLE
      bufferingTimeMsInLastMinute +=
        Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
    }

    setPlayerStateVariables("IDLE");
    // === Update QoS event work variables ===
  });

  player.addEventListener(PlayerState.ENDED, function () {
    console.log("Player State - ENDED");

    // === Update QoS event work variables ===
    if (lastPlayerState == "PLAYING") {
      // PLAYING -> ENDED
      playingTimeMsInLastMinute +=
        Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
    }

    setPlayerStateVariables("ENDED");
    // === Update QoS event work variables ===
  });

  // Attach event (error) listeners
  player.addEventListener(PlayerEventType.ERROR, function (err) {
    console.warn("Player Event - ERROR:", err);

    // === Update QoS event work variables ===
    const errorLog = new Error(
      '{"code":"' +
        err.code +
        '", "source":"' +
        err.source +
        '", "message":"' +
        err.message +
        '"}'
    );
    errorLog.name = err.type;
    errorCountInLastMinute += 1;
    window.DD_RUM.addError(errorLog);
    // === Update QoS event work variables ===
  });

  player.addEventListener(PlayerEventType.INITIALIZED, function (err) {
    console.log("Player Event - INITIALIZED");
    lastInitializedTime = Date.now();
  });

  // Attach event (quality changed) listeners
  player.addEventListener(PlayerEventType.QUALITY_CHANGED, function () {
    console.log("PlayerEventType - QUALITY_CHANGED");
  });

  // === Send off a QoS event every minute ===
  setInterval(function () {
    if (
      lastPlaybackStartOrPlaybackSummaryEventSentTime != -1 &&
      Date.now() - lastPlaybackStartOrPlaybackSummaryEventSentTime > 60000
    ) {
      sendPlaybackSummaryEventIfNecessary(player);

      // Reset work variables
      lastPlayerStateUpdateOrPlaybackSummaryEventSentTime =
        lastPlaybackStartOrPlaybackSummaryEventSentTime = Date.now();
      playingTimeMsInLastMinute = 0;
      bufferingTimeMsInLastMinute = 0;
      bufferingCountInLastMinute = 0;
      errorCountInLastMinute = 0;
    }
  }, 1000);
}
// === Send off a QoS event every minute ===

// === subroutines for sending QoS events and timed metadata feedback events ===
// Set the User and Session ID when the player loads a new video. The unique User ID is a random UUID, set as the very first
//   Session ID of this user, and remains the same even different sessions are played.
function setUserIDSessionID(player) {
  sessionId = player.getSessionId();

  if (typeof Storage !== "undefined") {
    if (!localStorage.getItem("ivs_qos_user_id")) {
      localStorage.setItem("ivs_qos_user_id", sessionId);
    }
    userId = localStorage.getItem("ivs_qos_user_id");
  } else {
    console.log("Sorry! No web storage support. Use Session ID as User Id");
    userId = sessionId;
  }
  ddRum.setUser({ id: userId });
}

function setPlayerStateVariables(myPlayerState) {
  lastPlayerState = myPlayerState;
  lastPlayerStateUpdateOrPlaybackSummaryEventSentTime = Date.now();
}

// Send off the last PLAYBACK_SUMMARY event
function sendOffLastPlaybackSummaryEvent(player) {
  sendPlaybackSummaryEventIfNecessary(player);
  // sendPlaybackEndEvent(player);
}

// Send playback QoS summary (PLAYBACK_SUMMARY) event
function sendPlaybackSummaryEventIfNecessary(player) {
  if (lastPlayerState == "PLAYING") {
    // collect the uncounted time in the PLAYING state
    playingTimeMsInLastMinute +=
      Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
  } else if (lastPlayerState == "BUFFERING") {
    // Collect the uncounted time in the BUFFERING state
    bufferingTimeMsInLastMinute +=
      Date.now() - lastPlayerStateUpdateOrPlaybackSummaryEventSentTime;
  }

  if (playingTimeMsInLastMinute > 0 || bufferingTimeMsInLastMinute > 0) {
    var myJson = {};
    myJson.metric_type = "PLAYBACK_SUMMARY";

    myJson.user_id = userId;
    myJson.session_id = sessionId;

    myJson.client_platform = "web";
    // myJson.is_live = isLive;
    myJson.channel_watched = channelWatched;

    myJson.playing_time_ms = playingTimeMsInLastMinute;
    myJson.buffering_time_ms = bufferingTimeMsInLastMinute;
    myJson.buffering_count = bufferingCountInLastMinute;
    myJson.error_count = errorCountInLastMinute;
    myJson.rendition_name = lastQuality.name;
    myJson.rendition_height = lastQuality.height;
    myJson.live_latency_ms = Math.round(player.getLiveLatency() * 1000);
    myJson.startup_latency_ms = startupLatencyMsOfThisSession;
    pushPayload(myJson);

    console.log("send QoS event - PlaybackSummary ", JSON.stringify(myJson));
  }
}

// Parse and get the Channel watched from the Playback URL
function getChannelWatched(playbackUrl) {
  var myIndex1 = playbackUrl.indexOf("channel.") + 8;
  var myIndex2 = playbackUrl.indexOf(".m3u8");
  var channelName = playbackUrl.substring(myIndex1, myIndex2);
  console.log("playbackUrl ", playbackUrl);
  console.log("Channel name :", channelName);
  return channelName;
}

function pushPayload(payload) {
  window.DD_RUM.onReady(function () {
    window.DD_RUM.addAction(payload.metric_type, payload);
  });
}

function log(msg) {
  console.log("[QoS SDK]:%s", msg);
}
