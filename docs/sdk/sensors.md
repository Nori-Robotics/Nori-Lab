# LiDAR and IMU

Robots advertising the `sensor_streams` capability can deliver the filtered planar LiDAR
scan from `/scan` and the body IMU from `/imu/data`. Both feeds are opt-in: connecting an SDK
does not add sensor traffic to the control data channel until the client requests it.

## TypeScript

```ts
const teleop = new RemoteTeleop({
  // ...normal connection options...
  onLidarScan: (scan) => {
    // angle for rangesM[i] = angleMinRad + i * angleIncrementRad
    console.log(scan.frameId, scan.rangesM);
  },
  onImu: (imu) => {
    console.log(imu.orientationXyzw, imu.angularVelocityRadS);
  },
});

const status = await teleop.configureSensorStreams({
  lidarHz: 5,
  imuHz: 20,
  lidarMaxPoints: 360,
});
console.log(status.lidarAvailable, status.imuAvailable);
```

`latestLidarScan()` and `latestImuSample()` return the latest cached samples.
`getSensorStreamStatus()` reads the effective rates and whether ROS currently sees a publisher
for each topic. Set a rate to `0` to stop that feed; omitted fields keep their current value.

`configureSensorStreams()` and `getSensorStreamStatus()` can also resolve with
**`unreachable: true`** — the client synthesized that status because the robot's reply never
arrived (timeout, closed channel, or session teardown). The robot never sends the field. Every
other field on such a status is the last value the robot reported, so a configuration you
cannot confirm does not read as "the sensors turned themselves off". Check `unreachable` before
trusting `lidarAvailable` / `imuAvailable`; the same rule as
[navigation](/sdk/navigation#unreachable-the-robot-did-not-answer).

## Python

```python
status = await robot.configure_sensor_streams(
    lidar_hz=5,
    imu_hz=20,
    lidar_max_points=360,
)

async for scan in robot.stream("lidar_scan"):
    print(scan.frame_id, scan.ranges_m)
```

Use `robot.stream("imu")` for `ImuSample` objects. The latest values are also available as
`robot.lidar_scan` and `robot.imu_sample`; `get_sensor_stream_status()` refreshes
`robot.sensor_stream_status`. Out-of-range rates raise `ValueError` before anything is sent,
and an unanswered request raises `RobotUnreachable` rather than returning a status — see
[the Python note on navigation](/sdk/navigation#python).

## Limits and data shape

| Setting | Range | Meaning |
|---|---:|---|
| LiDAR rate | 0–10 Hz | Upper bound; the source topic may publish more slowly. |
| IMU rate | 0–50 Hz | Upper bound; the source topic may publish more slowly. |
| LiDAR points | 16–1,440 | Maximum readings in each delivered scan. Default is 360. |

When a native scan exceeds `lidarMaxPoints`, the gateway takes readings at a uniform integer
stride. `sourcePoints` records the original count and the delivered `angleIncrementRad` and
`timeIncrementS` already include that stride. A `null` range, intensity, IMU component, or
covariance value represents a non-finite ROS value; it is unknown, never zero.

LiDAR frames include the ROS timestamp and frame ID, angular and timing metadata, sensor range
limits, ranges, and intensities when the driver supplies them. IMU frames include the split ROS
timestamp, frame ID, quaternion `[x,y,z,w]`, angular velocity in rad/s, linear acceleration in
m/s², and all three 3×3 covariance arrays.

::: warning Observational remote data
These feeds share the reliable WebRTC data channel with control, telemetry, and navigation.
Keep rates and LiDAR point counts only as high as the application needs. They are for remote
observation and application logic, not a replacement for the robot-local collision or safety
path. `lidarAvailable`/`imuAvailable` is a point-in-time publisher check; receipt of a fresh
sample is the authoritative liveness signal.
:::

## Develop without hardware

Both SDK mocks advertise `sensor_streams`. After configuration they produce deterministic
synthetic scans and stationary IMU samples at the requested upper rates, so callback, parsing,
backpressure, and application-state code can be tested without claiming real sensor physics.
